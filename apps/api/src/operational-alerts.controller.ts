import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { canManage, operationalAlertActionSchema, operationalAlertListSchema, operationalAlertSettingsSchema, requiresMfa } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

@Controller('admin/operational-alerts')
export class OperationalAlertsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest, roles: Role[]) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, roles)) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '運用アラートの権限と二段階認証を確認してください。' });
    return actor;
  }

  @Get()
  async list(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN', 'OPERATOR']); const input = operationalAlertListSchema.parse(query);
    const where = input.status === 'ALL' ? {} : { status: input.status };
    const [items, open, acknowledged, resolved] = await this.auth.db.$transaction([
      this.auth.db.operationalAlert.findMany({ where, orderBy: [{ detectedAt: 'desc' }, { id: 'asc' }], take: 100, include: { deliveries: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, recipient: true, status: true, attemptCount: true, lastErrorCode: true, sentAt: true, createdAt: true } } } }),
      this.auth.db.operationalAlert.count({ where: { status: 'OPEN' } }),
      this.auth.db.operationalAlert.count({ where: { status: 'ACKNOWLEDGED' } }),
      this.auth.db.operationalAlert.count({ where: { status: 'RESOLVED' } })
    ]);
    return { items, counts: { open, acknowledged, resolved } };
  }

  @Get('settings')
  async settings(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const value = await this.auth.db.operationalAlertSetting.findUniqueOrThrow({ where: { id: 'global' } });
    return { revision: value.revision, enabled: value.enabled, minimumSeverity: value.minimumSeverity, destinationEmails: value.destinationEmails, updatedAt: value.updatedAt };
  }

  @Patch('settings')
  async updateSettings(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req, ['ADMIN']); const input = operationalAlertSettingsSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7152026)::text`;
      const before = await tx.operationalAlertSetting.findUniqueOrThrow({ where: { id: 'global' } });
      if (before.revision !== input.revision) throw new ConflictException({ code: 'STALE_REVISION', message: '別の管理者がアラート設定を変更しました。再読み込みしてください。' });
      const after = await tx.operationalAlertSetting.update({ where: { id: 'global' }, data: { enabled: input.enabled, minimumSeverity: input.minimumSeverity, destinationEmails: input.destinationEmails, updatedBy: actor.id, updatedAt: new Date(), revision: { increment: 1 } } });
      await this.auth.audit(tx, req, 'OPERATIONAL_ALERT_SETTINGS_UPDATE', 'global', input.reason, { before: { enabled: before.enabled, minimumSeverity: before.minimumSeverity, destinationEmails: before.destinationEmails }, after: { enabled: after.enabled, minimumSeverity: after.minimumSeverity, destinationEmails: after.destinationEmails } });
      return { revision: after.revision, enabled: after.enabled, minimumSeverity: after.minimumSeverity, destinationEmails: after.destinationEmails, updatedAt: after.updatedAt };
    });
  }

  @Post(':alertId/acknowledge')
  async acknowledge(@Param('alertId') alertId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN', 'OPERATOR']); z.string().uuid().parse(alertId); const input = operationalAlertActionSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM operational_alerts WHERE id = ${alertId}::uuid FOR UPDATE`);
      const alert = await tx.operationalAlert.findUniqueOrThrow({ where: { id: alertId } });
      if (alert.status === 'RESOLVED') throw new ConflictException({ code: 'ALERT_ALREADY_RESOLVED', message: 'このアラートは解決済みです。' });
      if (alert.status === 'ACKNOWLEDGED') return alert;
      const now = new Date(); const updated = await tx.operationalAlert.update({ where: { id: alertId }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedBy: actor.id, acknowledgeReason: input.reason } });
      await this.auth.audit(tx, req, 'OPERATIONAL_ALERT_ACKNOWLEDGED', alertId, input.reason, { code: alert.code, sourceType: alert.sourceType, sourceId: alert.sourceId }); return updated;
    });
  }

  @Post(':alertId/resolve')
  async resolve(@Param('alertId') alertId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN', 'OPERATOR']); z.string().uuid().parse(alertId); const input = operationalAlertActionSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM operational_alerts WHERE id = ${alertId}::uuid FOR UPDATE`);
      const alert = await tx.operationalAlert.findUniqueOrThrow({ where: { id: alertId } });
      if (alert.status === 'RESOLVED') return alert;
      const now = new Date(); const updated = await tx.operationalAlert.update({ where: { id: alertId }, data: { status: 'RESOLVED', acknowledgedAt: alert.acknowledgedAt ?? now, acknowledgedBy: alert.acknowledgedBy ?? actor.id, acknowledgeReason: alert.acknowledgeReason ?? input.reason, resolvedAt: now, resolvedBy: actor.id, resolutionReason: input.reason } });
      await this.auth.audit(tx, req, 'OPERATIONAL_ALERT_RESOLVED', alertId, input.reason, { code: alert.code, sourceType: alert.sourceType, sourceId: alert.sourceId }); return updated;
    });
  }

  @Post('deliveries/:deliveryId/retry')
  async retry(@Param('deliveryId') deliveryId: string, @Body() body: unknown, @Req() req: AppRequest) {
    await this.staff(req, ['ADMIN', 'OPERATOR']); z.string().uuid().parse(deliveryId); const input = operationalAlertActionSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM operational_alert_deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`);
      const delivery = await tx.operationalAlertDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { alert: true } });
      if (delivery.status !== 'FAILED' || delivery.alert.status === 'RESOLVED') throw new ConflictException({ code: 'ALERT_DELIVERY_NOT_RETRYABLE', message: '失敗中の未解決アラートだけ再送できます。' });
      const updated = await tx.operationalAlertDelivery.update({ where: { id: deliveryId }, data: { status: 'QUEUED', nextAttemptAt: new Date(), lockedAt: null, leaseToken: null, updatedAt: new Date() } });
      await this.auth.audit(tx, req, 'OPERATIONAL_ALERT_DELIVERY_RETRY', deliveryId, input.reason, { alertId: delivery.alertId, attemptCount: delivery.attemptCount }); return updated;
    });
  }
}
