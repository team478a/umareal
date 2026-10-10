import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { bankTransferAccountSchema, bankTransferRequestSchema, bankTransferSettingsSchema, jstDate } from '@keiba/domain';
import type { BankTransferSettings } from '@keiba/domain';
import type { BankTransferRequest as StoredRequest } from '@keiba/db';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { createDayPassAccess } from './day-pass-access';
import { recordBillingEvent } from './billing-events';

@Injectable()
export class BankTransferService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private settingsView(value: {
    bankTransferEnabled: boolean;
    bankTransferBankName: string | null;
    bankTransferBranchName: string | null;
    bankTransferAccountType: string | null;
    bankTransferAccountNumber: string | null;
    bankTransferAccountHolder: string | null;
    bankTransferInstructions: string;
    bankTransferRequestValidityDays: number;
    bankTransferMonthlyAccessDays: number;
  }): BankTransferSettings {
    return bankTransferSettingsSchema.parse({
      enabled: value.bankTransferEnabled,
      bankName: value.bankTransferBankName ?? '',
      branchName: value.bankTransferBranchName ?? '',
      accountType: value.bankTransferAccountType ?? '',
      accountNumber: value.bankTransferAccountNumber ?? '',
      accountHolder: value.bankTransferAccountHolder ?? '',
      instructions: value.bankTransferInstructions,
      requestValidityDays: value.bankTransferRequestValidityDays,
      monthlyAccessDays: value.bankTransferMonthlyAccessDays
    });
  }

  private publicView(value: StoredRequest) {
    const snapshot = bankTransferAccountSchema.parse(value.bankAccountSnapshot);
    return bankTransferRequestSchema.parse({
      id: value.id,
      planCode: value.planCode,
      raceDate: value.raceDate,
      amountYen: value.amountYen,
      referenceCode: value.referenceCode,
      status: ['AWAITING_TRANSFER', 'TRANSFER_REPORTED'].includes(value.status) && value.expiresAt <= new Date() ? 'EXPIRED' : value.status,
      payerName: value.payerName,
      expiresAt: value.expiresAt,
      reportedAt: value.reportedAt,
      receivedAt: value.receivedAt,
      confirmedAt: value.confirmedAt,
      rejectedAt: value.rejectedAt,
      reviewReason: value.reviewReason,
      revision: value.revision,
      createdAt: value.createdAt,
      bankAccount: snapshot
    });
  }

  async settings() {
    const value = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    return { revision: value.revision, ...this.settingsView(value) };
  }

  async create(req: AppRequest, userId: string, input: { planCode: 'FOUNDER' | 'STANDARD' | 'DAY_PASS'; raceDate?: string }, idempotencyKey: string, requestHash: string) {
    const existing = await this.auth.db.bankTransferRequest.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' });
      return this.publicView(existing);
    }
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`bank-transfer:${userId}`}))::text`;
      const replay = await tx.bankTransferRequest.findUnique({ where: { idempotencyKey } });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' });
        return this.publicView(replay);
      }
      const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
      const configured = this.settingsView(settings);
      if (process.env.BILLING_TRANSPORT !== 'bank_transfer' || !configured.enabled || !settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'BANK_TRANSFER_UNAVAILABLE', message: '現在、銀行振込の新規申込を停止しています。' });
      const now = new Date();
      if (input.raceDate && input.raceDate < jstDate(now)) throw new BadRequestException({ code: 'PAST_RACE_DATE', message: '過去の日付は申し込めません。' });
      if (input.planCode === 'FOUNDER' && !settings.founderSalesEnabled) throw new ConflictException({ code: 'FOUNDER_SALES_CLOSED', message: '創設会員プランは販売していません。' });
      if (input.planCode === 'STANDARD' && !settings.standardSalesEnabled) throw new ConflictException({ code: 'STANDARD_SALES_CLOSED', message: '通常月額プランは現在販売していません。' });
      if (input.planCode === 'DAY_PASS' && !settings.dayPassSalesEnabled) throw new ConflictException({ code: 'DAY_PASS_SALES_CLOSED', message: '1日利用は現在販売していません。' });
      const open = await tx.bankTransferRequest.count({ where: { userId, status: { in: ['AWAITING_TRANSFER', 'TRANSFER_REPORTED'] }, expiresAt: { gt: now }, ...(input.planCode === 'DAY_PASS' ? { raceDate: input.raceDate } : { kind: 'SUBSCRIPTION' }) } });
      if (open) throw new ConflictException({ code: 'BANK_TRANSFER_REQUEST_EXISTS', message: '同じ内容の振込申込が確認待ちです。マイページをご確認ください。' });
      if (input.planCode === 'DAY_PASS' && await tx.dayPass.count({ where: { userId, raceDate: input.raceDate! } })) throw new ConflictException({ code: 'DAY_PASS_EXISTS', message: 'この開催日の1日利用は登録済みです。' });
      if (input.planCode !== 'DAY_PASS') {
        const active = await tx.entitlement.count({ where: { userId, planCode: { in: ['FOUNDER', 'STANDARD', 'REFERRAL_MONTHLY'] }, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } } });
        if (active) throw new ConflictException({ code: 'ACTIVE_ACCESS_EXISTS', message: '有効な月額相当の閲覧権限があります。期限後にお申し込みください。' });
      }
      if (input.planCode === 'FOUNDER') {
        const [subscriptions, transfers] = await Promise.all([
          tx.subscription.count({ where: { planCode: 'FOUNDER' } }),
          tx.bankTransferRequest.count({ where: { planCode: 'FOUNDER', status: 'CONFIRMED' } })
        ]);
        if (subscriptions + transfers >= settings.founderSalesLimit) throw new ConflictException({ code: 'FOUNDER_LIMIT_REACHED', message: '創設会員プランは販売上限に達しました。' });
      }
      const account = bankTransferAccountSchema.parse({ bankName: configured.bankName, branchName: configured.branchName, accountType: configured.accountType, accountNumber: configured.accountNumber, accountHolder: configured.accountHolder, instructions: configured.instructions });
      const amountYen = input.planCode === 'FOUNDER' ? settings.founderPriceYen : input.planCode === 'STANDARD' ? settings.standardPriceYen : settings.dayPassPriceYen;
      const created = await tx.bankTransferRequest.create({ data: {
        userId,
        kind: input.planCode === 'DAY_PASS' ? 'DAY_PASS' : 'SUBSCRIPTION',
        planCode: input.planCode,
        raceDate: input.raceDate ?? null,
        amountYen,
        referenceCode: `UM-${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
        bankAccountSnapshot: account,
        expiresAt: new Date(now.getTime() + configured.requestValidityDays * 86400000),
        idempotencyKey,
        requestHash
      } });
      await this.auth.audit(tx, req, 'BANK_TRANSFER_REQUEST_CREATE', created.id, '会員本人による銀行振込申込', { planCode: created.planCode, raceDate: created.raceDate, amountYen: created.amountYen, referenceCode: created.referenceCode, expiresAt: created.expiresAt }, 'BankTransferRequest');
      return this.publicView(created);
    }, { timeout: 20000, maxWait: 10000 });
  }

  async report(req: AppRequest, userId: string, id: string, input: { payerName: string; revision: number }, key: string, requestHash: string) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`bank-transfer-report:${id}`}))::text`;
      const previous = await tx.idempotencyKey.findUnique({ where: { key } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ操作キーが異なる内容で使われています。' });
        return previous.response;
      }
      const current = await tx.bankTransferRequest.findUnique({ where: { id } });
      if (!current || current.userId !== userId) throw new NotFoundException({ code: 'BANK_TRANSFER_NOT_FOUND', message: '振込申込を確認できません。' });
      if (current.revision !== input.revision) throw new ConflictException({ code: 'STALE_REVISION', message: '申込状態が更新されています。再読み込みしてください。' });
      if (current.expiresAt <= new Date()) throw new ConflictException({ code: 'BANK_TRANSFER_EXPIRED', message: '振込期限を過ぎています。新しくお申し込みください。' });
      if (current.status !== 'AWAITING_TRANSFER') throw new ConflictException({ code: 'BANK_TRANSFER_ALREADY_REPORTED', message: 'この申込は報告済み、または受付を終了しています。' });
      const updated = await tx.bankTransferRequest.update({ where: { id }, data: { status: 'TRANSFER_REPORTED', payerName: input.payerName, reportedAt: new Date(), revision: { increment: 1 } } });
      await this.auth.audit(tx, req, 'BANK_TRANSFER_REPORTED', id, '会員本人による振込報告', { payerName: input.payerName, referenceCode: updated.referenceCode }, 'BankTransferRequest');
      const response = this.publicView(updated);
      await tx.idempotencyKey.create({ data: { key, requestHash, response } });
      return response;
    });
  }

  async review(req: AppRequest, actorId: string, id: string, input: { action: 'CONFIRM' | 'REJECT'; receivedAmountYen?: number; receivedAt?: string; revision: number; reason: string }, key: string, requestHash: string) {
    return this.auth.db.$transaction(async tx => {
      const previous = await tx.idempotencyKey.findUnique({ where: { key } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ操作キーが異なる内容で使われています。' });
        return previous.response;
      }
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`bank-transfer-review:${id}`}))::text`;
      const replay = await tx.idempotencyKey.findUnique({ where: { key } });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ操作キーが異なる内容で使われています。' });
        return replay.response;
      }
      const current = await tx.bankTransferRequest.findUnique({ where: { id } });
      if (!current) throw new NotFoundException({ code: 'BANK_TRANSFER_NOT_FOUND', message: '振込申込を確認できません。' });
      if (current.revision !== input.revision) throw new ConflictException({ code: 'STALE_REVISION', message: '別の管理者または会員が状態を更新しました。再読み込みしてください。' });
      if (current.status !== 'TRANSFER_REPORTED') throw new ConflictException({ code: 'BANK_TRANSFER_NOT_REPORTED', message: '会員の振込報告後に確認してください。' });
      if (input.action === 'REJECT') {
        const rejected = await tx.bankTransferRequest.update({ where: { id }, data: { status: 'REJECTED', rejectedAt: new Date(), reviewedById: actorId, reviewReason: input.reason, revision: { increment: 1 } } });
        await this.auth.audit(tx, req, 'BANK_TRANSFER_REJECT', id, input.reason, { referenceCode: current.referenceCode, payerName: current.payerName }, 'BankTransferRequest');
        const response = this.publicView(rejected);
        await tx.idempotencyKey.create({ data: { key, requestHash, response } });
        return response;
      }
      if (input.receivedAmountYen !== current.amountYen) throw new ConflictException({ code: 'BANK_TRANSFER_AMOUNT_MISMATCH', message: '申込金額と着金額が一致しません。確認または却下を行ってください。' });
      const now = new Date();
      const receivedAt = new Date(input.receivedAt!);
      if (receivedAt > now) throw new BadRequestException({ code: 'BANK_TRANSFER_RECEIVED_AT_FUTURE', message: '着金日時に未来の時刻は指定できません。' });
      if (receivedAt > current.expiresAt) throw new ConflictException({ code: 'BANK_TRANSFER_RECEIVED_AFTER_DEADLINE', message: '振込期限後の着金です。確認ではなく却下または個別対応を行ってください。' });
      let entitlementId: string | null = null;
      let dayPassId: string | null = null;
      let notificationEventId: string | null = null;
      if (current.kind === 'DAY_PASS') {
        const access = await createDayPassAccess(tx, { userId: current.userId, raceDate: current.raceDate!, priceYen: current.amountYen, provider: 'BANK_TRANSFER', providerPassId: `bank:${current.id}`, reason: 'BANK_TRANSFER_CONFIRMED', actorId, source: 'BANK_TRANSFER' });
        dayPassId = access.pass.id;
        const notification = await tx.notificationEvent.create({ data: { billingEventId: access.billingEvent.id, eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: access.billingEvent.id } } });
        notificationEventId = notification.id;
      } else {
        const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { bankTransferMonthlyAccessDays: true } });
        const active = await tx.entitlement.count({ where: { userId: current.userId, planCode: { in: ['FOUNDER', 'STANDARD', 'REFERRAL_MONTHLY'] }, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } } });
        if (active) throw new ConflictException({ code: 'ACTIVE_ACCESS_EXISTS', message: 'すでに有効な月額相当の閲覧権限があります。重複付与せず対応を確認してください。' });
        const entitlement = await tx.entitlement.create({ data: { userId: current.userId, planCode: current.planCode, startsAt: now, endsAt: new Date(now.getTime() + settings.bankTransferMonthlyAccessDays * 86400000), reason: 'BANK_TRANSFER_CONFIRMED', grantedBy: actorId } });
        entitlementId = entitlement.id;
        const event = await recordBillingEvent(tx, { userId: current.userId, eventType: 'BANK_TRANSFER_ACCESS_STARTED', bankTransferRequestId: current.id, actorId, details: { planCode: current.planCode, amountYen: current.amountYen, accessEndsAt: entitlement.endsAt.toISOString() } }, 'BILLING_PAYMENT_SUCCEEDED');
        notificationEventId = event.id;
      }
      await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'BANK_TRANSFER', providerPaymentId: `bank:${current.id}`, kind: current.kind, status: 'SUCCEEDED', amountYen: current.amountYen, bankTransferRequestId: current.id } });
      const confirmed = await tx.bankTransferRequest.update({ where: { id }, data: { status: 'CONFIRMED', receivedAt, confirmedAt: now, reviewedById: actorId, reviewReason: input.reason, entitlementId, dayPassId, revision: { increment: 1 } } });
      await this.auth.audit(tx, req, 'BANK_TRANSFER_CONFIRM', id, input.reason, { referenceCode: current.referenceCode, payerName: current.payerName, amountYen: current.amountYen, receivedAt: input.receivedAt, entitlementId, dayPassId, notificationEventId }, 'BankTransferRequest');
      const response = this.publicView(confirmed);
      await tx.idempotencyKey.create({ data: { key, requestHash, response } });
      return response;
    }, { timeout: 20000, maxWait: 10000 });
  }

  async updateSettings(req: AppRequest, actorId: string, input: BankTransferSettings & { revision: number; reason: string }) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(8112026)::text`;
      const before = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
      if (before.revision !== input.revision) throw new ConflictException({ code: 'STALE_REVISION', message: '別の管理者が設定を変更しました。再読み込みしてください。' });
      if (input.enabled && process.env.BILLING_TRANSPORT !== 'bank_transfer') throw new ConflictException({ code: 'BANK_TRANSFER_TRANSPORT_DISABLED', message: '配備環境の決済方式をbank_transferへ切り替えてから有効にしてください。' });
      const after = await tx.systemSetting.update({ where: { id: 'global' }, data: {
        bankTransferEnabled: input.enabled,
        bankTransferBankName: input.bankName || null,
        bankTransferBranchName: input.branchName || null,
        bankTransferAccountType: input.accountType || null,
        bankTransferAccountNumber: input.accountNumber || null,
        bankTransferAccountHolder: input.accountHolder || null,
        bankTransferInstructions: input.instructions,
        bankTransferRequestValidityDays: input.requestValidityDays,
        bankTransferMonthlyAccessDays: input.monthlyAccessDays,
        updatedBy: actorId,
        updatedAt: new Date(),
        revision: { increment: 1 }
      } });
      await this.auth.audit(tx, req, 'BANK_TRANSFER_SETTINGS_UPDATE', 'global', input.reason, { before: this.settingsView(before), after: this.settingsView(after) }, 'SystemSetting');
      return { revision: after.revision, ...this.settingsView(after) };
    });
  }

  async memberRequests(userId: string) {
    const rows = await this.auth.db.bankTransferRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(row => this.publicView(row));
  }

  async adminRequests() {
    const rows = await this.auth.db.bankTransferRequest.findMany({ include: { user: { select: { displayName: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(row => ({ ...this.publicView(row), user: row.user }));
  }
}
