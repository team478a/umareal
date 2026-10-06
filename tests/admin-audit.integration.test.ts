import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, base, Client, db } from './helpers';

beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local' || !base.startsWith('http://127.0.0.1:')) throw new Error('Audit integration suite is local only');
});
afterAll(() => db.$disconnect());

describe('admin audit search', () => {
  it('requires ADMIN+AAL2, filters records and returns only safe fields', async () => {
    const member = await account(); const memberClient = new Client(); await memberClient.login(member);
    expect((await memberClient.call('admin/audit')).status).toBe(403);

    const admin = await account('ADMIN'); const client = new Client(); await client.login(admin);
    expect((await client.call('admin/audit')).status).toBe(403);
    await client.mfa();
    const requestId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await db.auditLog.create({ data: { actorId: admin.user.id, actorRole: 'ADMIN', action: 'AUDIT_SEARCH_TEST', targetType: 'TEST_TARGET', targetId, reason: '安全な表示の結合試験', details: { internalSecret: 'must-not-leak' }, requestId } });
    const response = await client.call(`admin/audit?action=SEARCH_TEST&targetType=TEST&requestId=${requestId}`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({ action: 'AUDIT_SEARCH_TEST', targetType: 'TEST_TARGET', targetId, actorRole: 'ADMIN', actorDisplayName: admin.user.displayName, requestId });
    expect(Object.keys(response.body.items[0]).sort()).toEqual(['id', 'action', 'targetType', 'targetId', 'reason', 'actorRole', 'actorDisplayName', 'createdAt', 'requestId'].sort());
    expect(JSON.stringify(response.body)).not.toMatch(/internalSecret|must-not-leak|actorId/);
    expect((await client.call('admin/audit?from=2026-10-07&to=2026-10-06')).status).toBe(400);
    expect((await client.call('admin/audit?unexpected=value')).status).toBe(400);
  });
});
