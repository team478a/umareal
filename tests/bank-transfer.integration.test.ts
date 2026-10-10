import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

describe.skipIf(process.env.BILLING_TRANSPORT !== 'bank_transfer')('bank transfer payment lifecycle', () => {
  let member: Client;
  let memberId: string;
  let admin: Client;

  beforeAll(async () => {
    const memberFixture = await account();
    memberId = memberFixture.user.id;
    member = new Client();
    await member.login(memberFixture);
    admin = new Client();
    await admin.login(await account('ADMIN'));
    await db.systemSetting.update({ where: { id: 'global' }, data: {
      newPurchasesEnabled: true,
      standardSalesEnabled: true,
      dayPassSalesEnabled: true,
      standardPriceYen: 2980,
      dayPassPriceYen: 980,
      bankTransferEnabled: true,
      bankTransferBankName: '検証銀行',
      bankTransferBranchName: '本店',
      bankTransferAccountType: '普通',
      bankTransferAccountNumber: '1234567',
      bankTransferAccountHolder: 'ウマリアル',
      bankTransferInstructions: '識別番号を振込名義の後に入力してください。',
      bankTransferRequestValidityDays: 3,
      bankTransferMonthlyAccessDays: 30
    } });
  });

  afterAll(async () => {
    await db.systemSetting.update({ where: { id: 'global' }, data: { bankTransferEnabled: false, newPurchasesEnabled: false } });
    await db.$disconnect();
  });

  it('creates a request without access and requires the member to report the payer name', async () => {
    const created = await member.call('billing/bank-transfers', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ planCode: 'STANDARD', amountYen: 2980, status: 'AWAITING_TRANSFER' });
    expect(created.body.referenceCode).toMatch(/^UM-[A-Z0-9]{10}$/);
    expect(await db.entitlement.count({ where: { userId: memberId, reason: 'BANK_TRANSFER_CONFIRMED' } })).toBe(0);
    expect(await db.paymentTransaction.count({ where: { bankTransferRequestId: created.body.id } })).toBe(0);

    const wrongUser = new Client();
    await wrongUser.login(await account());
    const hidden = await wrongUser.call(`billing/bank-transfers/${created.body.id}/report`, 'POST', { payerName: '別会員', revision: created.body.revision }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(hidden.status).toBe(404);

    const reported = await member.call(`billing/bank-transfers/${created.body.id}/report`, 'POST', { payerName: 'ウマリアル タロウ', revision: created.body.revision }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(reported.status).toBe(201);
    expect(reported.body).toMatchObject({ status: 'TRANSFER_REPORTED', payerName: 'ウマリアル タロウ', revision: created.body.revision + 1 });
  });

  it('requires ADMIN+AAL2, rejects a mismatched amount, and grants finite access exactly once', async () => {
    const current = await db.bankTransferRequest.findFirstOrThrow({ where: { userId: memberId, status: 'TRANSFER_REPORTED' }, orderBy: { createdAt: 'desc' } });
    const receivedAt = new Date(Math.min(Date.now() - 1000, current.expiresAt.getTime() - 1000)).toISOString();
    const beforeMfa = await admin.call(`admin/billing/bank-transfers/${current.id}/review`, 'POST', { action: 'CONFIRM', receivedAmountYen: 2980, receivedAt, revision: current.revision, reason: '結合試験' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(beforeMfa.status).toBe(403);
    await admin.mfa();

    const mismatch = await admin.call(`admin/billing/bank-transfers/${current.id}/review`, 'POST', { action: 'CONFIRM', receivedAmountYen: 2979, receivedAt, revision: current.revision, reason: '金額不一致の確認' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('BANK_TRANSFER_AMOUNT_MISMATCH');
    expect(await db.entitlement.count({ where: { userId: memberId, reason: 'BANK_TRANSFER_CONFIRMED' } })).toBe(0);

    const key = randomUUID();
    const confirmed = await admin.call(`admin/billing/bank-transfers/${current.id}/review`, 'POST', { action: 'CONFIRM', receivedAmountYen: 2980, receivedAt, revision: current.revision, reason: '入出金明細・名義・識別番号を照合済み' }, undefined, { 'Idempotency-Key': key });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.status).toBe('CONFIRMED');
    const replay = await admin.call(`admin/billing/bank-transfers/${current.id}/review`, 'POST', { action: 'CONFIRM', receivedAmountYen: 2980, receivedAt, revision: current.revision, reason: '入出金明細・名義・識別番号を照合済み' }, undefined, { 'Idempotency-Key': key });
    expect(replay.body).toEqual(confirmed.body);
    expect(await db.entitlement.count({ where: { userId: memberId, reason: 'BANK_TRANSFER_CONFIRMED' } })).toBe(1);
    expect(await db.subscription.count({ where: { userId: memberId } })).toBe(0);
    expect(await db.paymentTransaction.count({ where: { bankTransferRequestId: current.id, provider: 'BANK_TRANSFER', status: 'SUCCEEDED' } })).toBe(1);
    await expect(db.bankTransferRequest.update({ where: { id: current.id }, data: { reviewReason: '改変' } })).rejects.toThrow();
    await expect(db.bankTransferRequest.delete({ where: { id: current.id } })).rejects.toThrow();
  });

  it('uses the existing day-pass entitlement boundary after confirmation', async () => {
    const fixture = await account();
    const client = new Client();
    await client.login(fixture);
    const created = await client.call('billing/bank-transfers', 'POST', { planCode: 'DAY_PASS', raceDate: '2099-10-12' }, undefined, { 'Idempotency-Key': randomUUID() });
    const reported = await client.call(`billing/bank-transfers/${created.body.id}/report`, 'POST', { payerName: 'デイパス ケンショウ', revision: created.body.revision }, undefined, { 'Idempotency-Key': randomUUID() });
    const receivedAt = new Date(Date.now() - 1000).toISOString();
    const confirmed = await admin.call(`admin/billing/bank-transfers/${created.body.id}/review`, 'POST', { action: 'CONFIRM', receivedAmountYen: 980, receivedAt, revision: reported.body.revision, reason: '1日券の着金を照合済み' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(confirmed.status).toBe(201);
    const pass = await db.dayPass.findFirstOrThrow({ where: { userId: fixture.user.id, raceDate: '2099-10-12' }, include: { entitlement: true } });
    expect(pass).toMatchObject({ provider: 'BANK_TRANSFER', source: 'PURCHASE', status: 'ACTIVE' });
    expect(pass.endsAt.toISOString()).toBe('2099-10-12T15:00:00.000Z');
  });
});
