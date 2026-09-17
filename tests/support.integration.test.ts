import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';
import { runEmailNotificationBatch } from '../apps/worker/src/notification-runner';

describe('general member support', () => {
  let member: Client; let requestId: string;

  beforeAll(async () => { member = new Client(); await member.login(await account()); });
  afterAll(async () => { await db.$disconnect(); });

  it('creates an inquiry idempotently and returns only the member own content', async () => {
    const key = randomUUID();
    const body = { category: 'NOTIFICATION', subject: 'LINE通知が届きません', message: '連携済みと表示されていますが、対象レースの通知が届きませんでした。' };
    const created = await member.call('support/requests', 'POST', body, undefined, { 'Idempotency-Key': key });
    expect(created.status).toBe(201); expect(created.body).toMatchObject({ category: 'NOTIFICATION', status: 'OPEN', subject: body.subject }); requestId = created.body.id;
    const repeated = await member.call('support/requests', 'POST', body, undefined, { 'Idempotency-Key': key });
    expect(repeated.body).toEqual(created.body);
    expect(await db.supportRequest.count({ where: { id: requestId } })).toBe(1);
    const mine = await member.call('support/me');
    expect(mine.body.items.find((item: { id: string }) => item.id === requestId)).toMatchObject({ message: body.message, events: [] });
  });

  it('allows an operator to investigate and answer without exposing internal reasons', async () => {
    const operator = new Client(); await operator.login(await account('OPERATOR'));
    const started = await operator.call(`admin/support/${requestId}/status`, 'POST', { status: 'IN_PROGRESS', reason: '通知設定と配送履歴を確認します。', publicReply: null });
    expect(started.status).toBe(201); expect(started.body.status).toBe('IN_PROGRESS');
    const invalid = await operator.call(`admin/support/${requestId}/status`, 'POST', { status: 'OPEN', reason: '受付に戻します。', publicReply: null });
    expect(invalid.status).toBe(409); expect(invalid.body.code).toBe('SUPPORT_TRANSITION_INVALID');
    const answer = '通知設定を確認しました。次回の対象レース告知から受信できます。';
    const resolved = await operator.call(`admin/support/${requestId}/status`, 'POST', { status: 'RESOLVED', reason: '配信対象条件を確認し、会員へ案内します。', publicReply: answer });
    expect(resolved.body.status).toBe('RESOLVED');
    const mine = await member.call('support/me'); const item = mine.body.items.find((row: { id: string }) => row.id === requestId);
    expect(item.events).toEqual([expect.objectContaining({ publicMessage: answer })]);
    expect(JSON.stringify(item)).not.toContain('配信対象条件を確認');
    const resolvedEvent = await db.supportEvent.findFirstOrThrow({ where: { requestId, eventType: 'RESOLVED' } });
    const notification = await db.notificationEvent.findUniqueOrThrow({ where: { supportEventId: resolvedEvent.id } });
    const web = await member.call('me/notifications?limit=50');
    expect(web.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: notification.id, eventType: 'SUPPORT_RESPONSE_POSTED', href: '/support' })]));
    const sent: { targetId: string; text: string }[] = [];
    await runEmailNotificationBatch({ db, eventId: notification.id, transport: { async send(input) { sent.push({ targetId: input.targetId, text: input.message.text }); return { kind: 'SENT' as const, providerMessageId: `support-${input.targetId}` }; } } });
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: resolvedEvent.id })]));
    const externalText = sent.find(row => row.targetId === resolvedEvent.id)!.text;
    expect(externalText).toContain('/support'); expect(externalText).not.toContain(item.subject); expect(externalText).not.toContain(answer);
    expect(await db.auditLog.count({ where: { targetId: requestId, action: 'SUPPORT_STATUS_CHANGED' } })).toBe(2);
  });

  it('requires administrator AAL2 and protects inquiry history in PostgreSQL', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/support')).body.code).toBe('MFA_REQUIRED'); await admin.mfa();
    expect((await admin.call('admin/support?status=RESOLVED')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: requestId, status: 'RESOLVED' })]));
    const event = await db.supportEvent.findFirstOrThrow({ where: { requestId } });
    await expect(db.supportEvent.update({ where: { id: event.id }, data: { reason: 'changed' } })).rejects.toThrow(/append-only/);
    await expect(db.supportRequest.update({ where: { id: requestId }, data: { subject: 'changed' } })).rejects.toThrow(/content is immutable/);
    await expect(db.supportRequest.delete({ where: { id: requestId } })).rejects.toThrow(/cannot be deleted/);
  });

  it('lets only the owner append a message idempotently and reopens a resolved inquiry', async () => {
    const key = randomUUID(); const message = '追加で確認したところ、メール通知も同じように届いていません。';
    const added = await member.call(`support/requests/${requestId}/messages`, 'POST', { message }, undefined, { 'Idempotency-Key': key });
    expect(added.status).toBe(201); expect(added.body).toMatchObject({ requestId, status: 'OPEN', reopened: true });
    const repeated = await member.call(`support/requests/${requestId}/messages`, 'POST', { message }, undefined, { 'Idempotency-Key': key });
    expect(repeated.body).toEqual(added.body);
    expect(await db.supportEvent.count({ where: { requestId, eventType: 'MEMBER_MESSAGE' } })).toBe(1);

    const mine = await member.call('support/me'); const item = mine.body.items.find((row: { id: string }) => row.id === requestId);
    expect(item).toMatchObject({ status: 'OPEN' });
    expect(item.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'MEMBER_MESSAGE', actorRole: 'MEMBER', publicMessage: message })]));
    expect(JSON.stringify(item)).not.toContain('会員本人の追加質問により受付を再開');

    const other = new Client(); const otherAccount = await account(); await other.login(otherAccount);
    const rejected = await other.call(`support/requests/${requestId}/messages`, 'POST', { message: 'この問い合わせには追記できません。' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(rejected.status).toBe(404); expect(rejected.body.code).toBe('SUPPORT_REQUEST_NOT_FOUND');
    await expect(db.supportEvent.create({ data: { requestId, eventType: 'MEMBER_MESSAGE', actorId: otherAccount.user.id, actorRole: 'ADMIN', reason: 'invalid', publicMessage: 'invalid' } })).rejects.toThrow();
    expect(await db.auditLog.count({ where: { targetId: requestId, action: 'SUPPORT_MEMBER_MESSAGE_ADDED' } })).toBe(1);
  });

  it('lets operations assign priority, owner and deadline without exposing triage to the member', async () => {
    const operator = new Client(); const operatorAccount = await account('OPERATOR'); await operator.login(operatorAccount);
    const dueAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const updated = await operator.call(`admin/support/${requestId}/triage`, 'POST', { priority: 'URGENT', assignedToId: operatorAccount.user.id, dueAt, reason: '次回配信前に通知設定を確認するため' });
    expect(updated.status).toBe(201); expect(updated.body).toMatchObject({ id: requestId, priority: 'URGENT', assignedToId: operatorAccount.user.id, assignee: { displayName: operatorAccount.user.displayName } });

    const queue = await operator.call('admin/support?status=OPEN');
    expect(queue.body.assignees).toEqual(expect.arrayContaining([expect.objectContaining({ id: operatorAccount.user.id, role: 'OPERATOR' })]));
    const queuedItem = queue.body.items.find((row: { id: string }) => row.id === requestId);
    expect(queuedItem).toMatchObject({ id: requestId, priority: 'URGENT', assignedToId: operatorAccount.user.id });
    expect(queuedItem.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'TRIAGED', reason: '次回配信前に通知設定を確認するため' })]));

    const invalidAssignee = await account();
    const rejected = await operator.call(`admin/support/${requestId}/triage`, 'POST', { priority: 'HIGH', assignedToId: invalidAssignee.user.id, dueAt: null, reason: '無効な担当者の指定試験' });
    expect(rejected.status).toBe(409); expect(rejected.body.code).toBe('SUPPORT_ASSIGNEE_INVALID');
    await expect(db.supportRequest.update({ where: { id: requestId }, data: { assignedToId: invalidAssignee.user.id } })).rejects.toThrow(/active administrator or operator/);

    const mine = await member.call('support/me'); const memberItem = mine.body.items.find((row: { id: string }) => row.id === requestId);
    expect(JSON.stringify(memberItem)).not.toContain('URGENT'); expect(JSON.stringify(memberItem)).not.toContain(operatorAccount.user.displayName);
    expect(await db.auditLog.count({ where: { targetId: requestId, action: 'SUPPORT_TRIAGE_UPDATED' } })).toBe(1);
  });
});
