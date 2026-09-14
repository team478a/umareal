import { BadRequestException, Controller, Inject, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { launchCapabilities, resolveLaunchMode } from '@keiba/domain';
import { AuthService } from './auth.service';
import { decrypt, hashToken } from './security';
import { verifyLineWebhookSignature } from './line-webhook';

const eventSchema = z.object({
  type: z.string().min(1).max(100), webhookEventId: z.string().min(1).max(100),
  timestamp: z.number().int().min(0).max(8_640_000_000_000_000),
  source: z.object({ type: z.string().max(30), userId: z.string().min(1).max(255).optional() }).passthrough().optional()
}).passthrough();
const webhookSchema = z.object({ destination: z.string().max(255).optional(), events: z.array(eventSchema).max(100) }).passthrough();

@Controller('webhooks/line')
export class LineWebhookController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post()
  async receive(@Req() req: RawBodyRequest<Request>) {
    if (!launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).lineNotifications) throw new ServiceUnavailableException({ code: 'LINE_WEBHOOK_NOT_IN_LAUNCH', message: 'LINE通知は現在の公開範囲では利用できません。' });
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException({ code: 'LINE_RAW_BODY_REQUIRED', message: 'Webhook本文を確認できません。' });
    const settings = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineChannelSecretEncrypted: true } });
    if (!settings.lineChannelSecretEncrypted) throw new ServiceUnavailableException({ code: 'LINE_WEBHOOK_NOT_CONFIGURED', message: 'LINE Webhookは未設定です。' });
    let secret: string;
    try { secret = decrypt(settings.lineChannelSecretEncrypted); } catch { throw new ServiceUnavailableException({ code: 'LINE_WEBHOOK_CONFIGURATION_INVALID', message: 'LINE Webhook設定を確認してください。' }); }
    const signatureHeader = req.headers['x-line-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!verifyLineWebhookSignature(rawBody, signature, secret)) throw new UnauthorizedException({ code: 'LINE_SIGNATURE_INVALID', message: 'Webhook署名を確認できません。' });
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { throw new BadRequestException({ code: 'LINE_WEBHOOK_INVALID_JSON', message: 'Webhook本文を処理できません。' }); }
    const body = webhookSchema.parse(parsed);
    const summary = await this.auth.db.$transaction(async tx => {
      const subjects = [...new Set(body.events.flatMap(event => event.source?.type === 'user' && event.source.userId ? [event.source.userId] : []))];
      const accounts = subjects.length ? await tx.lineAccount.findMany({ where: { subject: { in: subjects }, unlinkedAt: null }, select: { id: true, subject: true } }) : [];
      const accountBySubject = new Map(accounts.map(account => [account.subject, account.id]));
      const rows = body.events.map(event => {
        const userId = event.source?.type === 'user' ? event.source.userId : undefined;
        const handled = ['follow', 'unfollow'].includes(event.type) && !!userId;
        return { webhookEventId: event.webhookEventId, eventType: event.type, subjectHash: userId ? hashToken(userId) : null, occurredAt: new Date(event.timestamp), outcome: handled ? accountBySubject.has(userId!) ? 'MATCHED' : 'UNMATCHED' : 'IGNORED' };
      });
      const inserted = rows.length ? await tx.lineWebhookEvent.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
      const latest = new Map<string, { type: string; occurredAt: Date }>();
      for (const event of body.events) {
        const userId = event.source?.type === 'user' ? event.source.userId : undefined;
        if (!userId || !accountBySubject.has(userId) || !['follow', 'unfollow'].includes(event.type)) continue;
        const occurredAt = new Date(event.timestamp); const current = latest.get(userId);
        if (!current || occurredAt >= current.occurredAt) latest.set(userId, { type: event.type, occurredAt });
      }
      for (const [subject, event] of latest) await tx.lineAccount.updateMany({ where: { id: accountBySubject.get(subject), OR: [{ lastWebhookAt: null }, { lastWebhookAt: { lt: event.occurredAt } }] }, data: { lastWebhookAt: event.occurredAt, notificationDisabledAt: event.type === 'unfollow' ? event.occurredAt : null } });
      return { events: inserted.count, duplicates: rows.length - inserted.count };
    });
    return { accepted: true, ...summary };
  }
}
