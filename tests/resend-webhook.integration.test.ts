import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { encryptSecret } from '../packages/db/src';
import { account, Client, db } from './helpers';

const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
let previousSecret: string | null = null;

function signed(body: unknown, id = `msg_${randomUUID()}`) {
  const payload = JSON.stringify(body);
  const timestamp = new Date();
  const seconds = String(Math.floor(timestamp.getTime() / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64')).update(`${id}.${seconds}.${payload}`).digest('base64');
  return { payload, headers: { 'svix-id': id, 'svix-timestamp': seconds, 'svix-signature': `v1,${signature}` } };
}

async function send(body: unknown, id?: string, signatureOverride?: string) {
  const value = signed(body, id);
  const response = await fetch(`${process.env.API_BASE_URL ?? 'http://127.0.0.1:4000'}/api/v1/webhooks/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...value.headers, ...(signatureOverride ? { 'svix-signature': signatureOverride } : {}) }, body: value.payload });
  return { status: response.status, body: await response.json() };
}

function event(type: string, to: string) {
  return { type, created_at: new Date().toISOString(), data: { email_id: `email_${randomUUID()}`, to: [to], subject: '保存してはいけない件名', from: 'secret@example.test' } };
}

beforeAll(async () => {
  previousSecret = (await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { mailWebhookSecretEncrypted: true } })).mailWebhookSecretEncrypted;
  await db.systemSetting.update({ where: { id: 'global' }, data: { mailWebhookSecretEncrypted: encryptSecret(secret) } });
});

afterAll(async () => {
  await db.systemSetting.update({ where: { id: 'global' }, data: { mailWebhookSecretEncrypted: previousSecret } });
  await db.$disconnect();
});

describe('Resend delivery failure webhook', () => {
  it('verifies the raw body, disables a bounced recipient once, and exposes safe operations data', async () => {
    const fixture = await account();
    const body = event('email.bounced', fixture.user.email!);
    expect((await send(body, `msg_bad_${randomUUID()}`, 'v1,invalid')).status).toBe(401);

    const eventId = `msg_${randomUUID()}`;
    const first = await send(body, eventId);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ accepted: true, duplicate: false, outcome: 'DISABLED', recipients: 1, matched: 1, disabled: 1 });
    const replay = await send(body, eventId);
    expect(replay.body).toMatchObject({ accepted: true, duplicate: true });
    expect(await db.emailWebhookEvent.count({ where: { providerEventId: eventId } })).toBe(1);

    const user = await db.user.findUniqueOrThrow({ where: { id: fixture.user.id }, include: { preferences: true } });
    expect(user.emailDeliveryDisabledReason).toBe('BOUNCED');
    expect(user.emailDeliveryDisabledAt).toBeInstanceOf(Date);
    expect(user.preferences?.emailEnabled).toBe(false);

    const member = new Client(); await member.login(fixture);
    const me = await member.call('me');
    expect(me.body).toMatchObject({ emailNotificationState: 'BLOCKED', emailNotificationReady: false, emailDeliveryDisabledReason: 'BOUNCED' });
    const enable = await member.call('me/preferences', 'PATCH', { emailEnabled: true, predictions: true, changes: true, articles: false, billing: true });
    expect(enable.body.code).toBe('EMAIL_DELIVERY_BLOCKED');

    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const operations = await admin.call('admin/notifications');
    expect(operations.status).toBe(200);
    expect(operations.body.emailWebhook.blockedMembers).toEqual(expect.arrayContaining([expect.objectContaining({ id: fixture.user.id, emailDeliveryDisabledReason: 'BOUNCED' })]));
    expect(JSON.stringify(operations.body.emailWebhook)).not.toContain('保存してはいけない件名');

    const stored = await db.emailWebhookEvent.findUniqueOrThrow({ where: { providerEventId: eventId } });
    await expect(db.emailWebhookEvent.update({ where: { id: stored.id }, data: { outcome: 'MATCHED' } })).rejects.toThrow();
    await expect(db.emailWebhookEvent.delete({ where: { id: stored.id } })).rejects.toThrow();

    const reason = '本人が受信可能な状態へ修正したことを確認';
    expect((await member.call(`admin/notifications/email-blocks/${fixture.user.id}/release`, 'POST', { reason })).status).toBe(403);
    const released = await admin.call(`admin/notifications/email-blocks/${fixture.user.id}/release`, 'POST', { reason });
    expect(released.body).toMatchObject({ userId: fixture.user.id, emailNotificationState: 'DISABLED', emailEnabled: false });
    const afterRelease = await db.user.findUniqueOrThrow({ where: { id: fixture.user.id }, include: { preferences: true } });
    expect(afterRelease.emailDeliveryDisabledAt).toBeNull();
    expect(afterRelease.preferences?.emailEnabled).toBe(false);
    expect(await db.auditLog.findFirst({ where: { action: 'EMAIL_DELIVERY_BLOCK_RELEASE', targetId: fixture.user.id, reason } })).not.toBeNull();
    expect((await member.call('me/preferences', 'PATCH', { emailEnabled: true, predictions: true, changes: true, articles: false, billing: true })).status).toBe(200);
  });

  it('records provider failures without disabling the recipient', async () => {
    const fixture = await account();
    const response = await send(event('email.failed', fixture.user.email!));
    expect(response.body).toMatchObject({ accepted: true, outcome: 'MATCHED', matched: 1, disabled: 0 });
    const user = await db.user.findUniqueOrThrow({ where: { id: fixture.user.id }, include: { preferences: true } });
    expect(user.emailDeliveryDisabledAt).toBeNull();
    expect(user.preferences?.emailEnabled).toBe(true);
  });
});
