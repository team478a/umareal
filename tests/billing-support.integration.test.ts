import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';

describe('billing support requests', () => {
  let member: Client;
  let memberId: string;
  let paymentId: string;
  let requestId: string;

  beforeAll(async () => {
    const fixture = await account();
    memberId = fixture.user.id;
    member = new Client();
    await member.login(fixture);
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: true, standardPriceYen: 2980 } });
    const purchase = await member.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() });
    paymentId = purchase.body.paymentId;
  });

  afterAll(async () => {
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: false } });
    await db.$disconnect();
  });

  it('requires an owned payment and creates the request idempotently', async () => {
    const key = randomUUID();
    const body = { category: 'REFUND', paymentTransactionId: paymentId, message: 'この支払いについて返金条件と手続きを確認したいです。' };
    const first = await member.call('billing/support-requests', 'POST', body, undefined, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ category: 'REFUND', status: 'OPEN', paymentTransactionId: paymentId });
    requestId = first.body.id;
    const replay = await member.call('billing/support-requests', 'POST', body, undefined, { 'Idempotency-Key': key });
    expect(replay.body).toEqual(first.body);
    expect(await db.billingSupportRequest.count({ where: { id: requestId } })).toBe(1);
    expect(await db.billingSupportEvent.count({ where: { requestId, eventType: 'CREATED' } })).toBe(1);

    const other = await account();
    const otherClient = new Client();
    await otherClient.login(other);
    const otherPurchase = await otherClient.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() });
    const denied = await member.call('billing/support-requests', 'POST', { ...body, paymentTransactionId: otherPurchase.body.paymentId }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PAYMENT_ACCESS_DENIED');
    expect(other.user.id).not.toBe(memberId);
  });

  it('returns only the member own requests without internal response reasons', async () => {
    const mine = await member.call('billing/me');
    expect(mine.status).toBe(200);
    const support = mine.body.supportRequests.find((item: { id: string }) => item.id === requestId);
    expect(support).toMatchObject({ category: 'REFUND', status: 'OPEN' });
    expect(support.events[0]).toEqual(expect.objectContaining({ eventType: 'CREATED' }));
    expect(support.events[0].reason).toBeUndefined();
  });

  it('requires administrator AAL2 and records valid status transitions', async () => {
    expect((await member.call('admin/billing')).status).toBe(403);
    const admin = new Client();
    await admin.login(await account('ADMIN'));
    const staffSubmission = await admin.call('billing/support-requests', 'POST', { category: 'OTHER', paymentTransactionId: null, message: '管理者ロールからの本人受付は拒否されます。' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(staffSubmission.status).toBe(403);
    expect(staffSubmission.body.code).toBe('MEMBER_REQUIRED');
    expect((await admin.call(`admin/billing/support-requests/${requestId}/status`, 'POST', { status: 'IN_PROGRESS', reason: '内容と対象決済を確認します。' })).body.code).toBe('MFA_REQUIRED');
    await admin.mfa();
    const started = await admin.call(`admin/billing/support-requests/${requestId}/status`, 'POST', { status: 'IN_PROGRESS', reason: '内容と対象決済を確認します。' });
    expect(started.status).toBe(201);
    expect(started.body.status).toBe('IN_PROGRESS');
    const invalid = await admin.call(`admin/billing/support-requests/${requestId}/status`, 'POST', { status: 'OPEN', reason: '受付へ戻す試験' });
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe('BILLING_SUPPORT_TRANSITION_INVALID');
    const resolved = await admin.call(`admin/billing/support-requests/${requestId}/status`, 'POST', { status: 'RESOLVED', reason: '確認結果を会員へ案内済みです。' });
    expect(resolved.body.status).toBe('RESOLVED');
    expect(await db.billingSupportEvent.count({ where: { requestId } })).toBe(3);
    expect(await db.auditLog.count({ where: { targetId: requestId, action: 'BILLING_SUPPORT_STATUS_CHANGED' } })).toBe(2);
  });

  it('protects support history and requests from deletion in PostgreSQL', async () => {
    const event = await db.billingSupportEvent.findFirstOrThrow({ where: { requestId } });
    await expect(db.billingSupportEvent.update({ where: { id: event.id }, data: { reason: 'changed' } })).rejects.toThrow(/append-only/);
    await expect(db.billingSupportRequest.update({ where: { id: requestId }, data: { message: 'changed content' } })).rejects.toThrow(/content is immutable/);
    await expect(db.billingSupportRequest.delete({ where: { id: requestId } })).rejects.toThrow(/cannot be deleted/);
  });
});
