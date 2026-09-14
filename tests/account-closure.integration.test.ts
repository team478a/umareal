import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('account closure and retained history', () => {
  it('closes a free member, revokes every session and access path, and preserves append-only records', async () => {
    const fixture = await account();
    await db.lineAccount.create({ data: { userId: fixture.user.id, subject: `closure-${randomUUID()}` } });
    const entitlement = await db.entitlement.create({ data: { userId: fixture.user.id, planCode: 'MANUAL', startsAt: new Date(), endsAt: new Date(Date.now() + 86400000), reason: '退会結合試験', grantedBy: fixture.user.id } });
    const first = new Client(); const second = new Client(); await first.login(fixture); await second.login(fixture);
    const eligibility = await first.call('me/closure');
    expect(eligibility.status).toBe(200); expect(eligibility.body).toMatchObject({ eligible: true, passwordRequired: true, retentionPolicyVersion: 'development-v1' });
    expect((await first.call('me/close', 'POST', { reasonCode: 'OTHER', confirmation: '退会', currentPassword: fixture.password })).status).toBe(400);
    expect((await first.call('me/close', 'POST', { reasonCode: 'OTHER', confirmation: '退会する', currentPassword: 'wrong-password' })).status).toBe(401);
    const closed = await first.call('me/close', 'POST', { reasonCode: 'SERVICE_NO_LONGER_NEEDED', confirmation: '退会する', currentPassword: fixture.password });
    expect(closed.status).toBe(201); expect(closed.body).toMatchObject({ alreadyClosed: false, retainedHistory: true });
    expect(closed.headers.get('set-cookie')).toContain('keiba_session=;');
    expect((await first.call('me')).status).toBe(401); expect((await second.call('me')).status).toBe(401);
    expect((await new Client().call('auth/login', 'POST', { email: fixture.user.email, password: fixture.password })).status).toBe(401);

    const [user, preferences, line, revoked, closure, audit, sessions] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: fixture.user.id } }), db.notificationPreference.findUniqueOrThrow({ where: { userId: fixture.user.id } }),
      db.lineAccount.findUniqueOrThrow({ where: { userId: fixture.user.id } }), db.entitlement.findUniqueOrThrow({ where: { id: entitlement.id } }),
      db.accountClosure.findUniqueOrThrow({ where: { userId: fixture.user.id } }), db.auditLog.findFirstOrThrow({ where: { targetId: fixture.user.id, action: 'ACCOUNT_CLOSED' } }),
      db.session.count({ where: { userId: fixture.user.id } })
    ]);
    expect(user.disabledAt).not.toBeNull(); expect(preferences).toMatchObject({ predictions: false, changes: false, articles: false, billing: false });
    expect(line.unlinkedAt).not.toBeNull(); expect(line.notificationDisabledAt).not.toBeNull(); expect(revoked.revokedAt).not.toBeNull(); expect(sessions).toBe(0);
    expect(closure).toMatchObject({ reasonCode: 'SERVICE_NO_LONGER_NEEDED', retentionPolicyVersion: 'development-v1' }); expect(audit.details).toMatchObject({ closureId: closure.id });
    await expect(db.accountClosure.update({ where: { id: closure.id }, data: { reasonCode: 'PRICE' } })).rejects.toThrow();
    await expect(db.accountClosure.delete({ where: { id: closure.id } })).rejects.toThrow();

    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/account-closures')).status).toBe(403); await admin.mfa();
    const records = await admin.call('admin/account-closures'); expect(records.status).toBe(200);
    expect(records.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: closure.id, status: 'CLOSED', retentionPolicyVersion: 'development-v1' })]));
    expect(JSON.stringify(records.body)).not.toMatch(/passwordHash|mfaSecret|tokenHash/);
  });

  it('does not close a member while paid access is still active', async () => {
    const fixture = await account(); const now = new Date(); const endsAt = new Date(now.getTime() + 86400000);
    const entitlement = await db.entitlement.create({ data: { userId: fixture.user.id, planCode: 'STANDARD', startsAt: now, endsAt, reason: '退会ブロック試験', grantedBy: fixture.user.id } });
    await db.subscription.create({ data: { userId: fixture.user.id, planCode: 'STANDARD', status: 'ACTIVE', priceYen: 2980, currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, provider: 'LOCAL_TEST', providerSubscriptionId: `closure-sub-${randomUUID()}`, entitlementId: entitlement.id } });
    const client = new Client(); await client.login(fixture);
    const eligibility = await client.call('me/closure'); expect(eligibility.body.eligible).toBe(false); expect(eligibility.body.blockers[0].code).toBe('ACTIVE_SUBSCRIPTION');
    const response = await client.call('me/close', 'POST', { reasonCode: 'PRICE', confirmation: '退会する', currentPassword: fixture.password });
    expect(response.status).toBe(409); expect(response.body.code).toBe('ACTIVE_BILLING_EXISTS');
    expect((await client.call('me')).status).toBe(200); expect(await db.accountClosure.findUnique({ where: { userId: fixture.user.id } })).toBeNull();
  });
});
