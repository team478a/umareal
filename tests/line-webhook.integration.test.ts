import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../apps/api/src/security';
import { account, base, db } from './helpers';

const secret = 'integration-line-channel-secret';
let previousSecret: string | null;
beforeAll(async () => {
  previousSecret = (await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineChannelSecretEncrypted: true } })).lineChannelSecretEncrypted;
  await db.systemSetting.update({ where: { id: 'global' }, data: { lineChannelSecretEncrypted: encrypt(secret) } });
});
afterAll(async () => { await db.systemSetting.update({ where: { id: 'global' }, data: { lineChannelSecretEncrypted: previousSecret } }); await db.$disconnect(); });

async function send(body: string, signature = createHmac('sha256', secret).update(body).digest('base64')) {
  const response = await fetch(`${base}/api/v1/webhooks/line`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': signature }, body });
  return { status: response.status, body: await response.json() };
}
function payload(event: { type: string; webhookEventId: string; timestamp: number; userId: string }) {
  return JSON.stringify({ destination: 'U-bot', events: [{ type: event.type, webhookEventId: event.webhookEventId, timestamp: event.timestamp, deliveryContext: { isRedelivery: false }, source: { type: 'user', userId: event.userId } }] });
}

describe('LINE webhook receiver', () => {
  it('verifies signatures, deduplicates redelivery and applies only newer follow state', async () => {
    const member = await account(); const subject = `U-${randomUUID()}`;
    await db.lineAccount.create({ data: { userId: member.user.id, subject } });
    const timestamp = Date.now(); const unfollowId = `evt-${randomUUID()}`; const unfollow = payload({ type: 'unfollow', webhookEventId: unfollowId, timestamp, userId: subject });
    expect((await send(unfollow)).status).toBe(201);
    expect(await db.lineAccount.findUnique({ where: { subject } })).toMatchObject({ lastWebhookAt: new Date(timestamp), notificationDisabledAt: new Date(timestamp) });

    const duplicate = await send(unfollow); expect(duplicate.status).toBe(201); expect(duplicate.body).toMatchObject({ events: 0, duplicates: 1 });
    expect(await db.lineWebhookEvent.count({ where: { webhookEventId: unfollowId } })).toBe(1);

    const oldFollow = payload({ type: 'follow', webhookEventId: `evt-${randomUUID()}`, timestamp: timestamp - 1000, userId: subject });
    await send(oldFollow); expect((await db.lineAccount.findUniqueOrThrow({ where: { subject } })).notificationDisabledAt).not.toBeNull();
    const newFollow = payload({ type: 'follow', webhookEventId: `evt-${randomUUID()}`, timestamp: timestamp + 1000, userId: subject });
    await send(newFollow); expect(await db.lineAccount.findUnique({ where: { subject } })).toMatchObject({ lastWebhookAt: new Date(timestamp + 1000), notificationDisabledAt: null });

    const stored = await db.lineWebhookEvent.findUniqueOrThrow({ where: { webhookEventId: unfollowId } });
    expect(stored.subjectHash).not.toBe(subject); expect(JSON.stringify(stored)).not.toContain(subject);
    await expect(db.lineWebhookEvent.update({ where: { id: stored.id }, data: { outcome: 'IGNORED' } })).rejects.toThrow();
    await expect(db.lineWebhookEvent.delete({ where: { id: stored.id } })).rejects.toThrow();
  });

  it('rejects invalid signatures before parsing or changing data', async () => {
    const id = `evt-${randomUUID()}`; const body = payload({ type: 'unfollow', webhookEventId: id, timestamp: Date.now(), userId: `U-${randomUUID()}` });
    const response = await send(body, 'invalid-signature');
    expect(response.status).toBe(401); expect(response.body.code).toBe('LINE_SIGNATURE_INVALID');
    expect(await db.lineWebhookEvent.count({ where: { webhookEventId: id } })).toBe(0);
  });
});
