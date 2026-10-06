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
    expect((await new Client().call('me/closure')).status).toBe(401);
    const eligibility = await first.call('me/closure');
    expect(eligibility.status).toBe(200); expect(eligibility.body).toMatchObject({ eligible: true, passwordRequired: true }); expect(eligibility.body.retentionPolicyVersion).toEqual(expect.any(String));
    expect(Object.keys(eligibility.body).sort()).toEqual(['blockers', 'eligible', 'passwordRequired', 'retained', 'retentionPolicyVersion'].sort());
    expect(eligibility.body.blockers).toEqual([]);
    expect(JSON.stringify(eligibility.body)).not.toMatch(/passwordHash|userId|subscriptionId|dayPassId|checkoutId/);
    expect((await first.call('me/close', 'POST', { reasonCode: 'OTHER', confirmation: '退会', currentPassword: fixture.password })).status).toBe(400);
    expect((await first.call('me/close', 'POST', { reasonCode: 'OTHER', confirmation: '退会する', currentPassword: 'wrong-password' })).status).toBe(401);
    const closed = await first.call('me/close', 'POST', { reasonCode: 'SERVICE_NO_LONGER_NEEDED', confirmation: '退会する', currentPassword: fixture.password });
    expect(closed.status).toBe(201); expect(closed.body).toMatchObject({ alreadyClosed: false, retainedHistory: true });
    expect(Object.keys(closed.body).sort()).toEqual(['alreadyClosed', 'closedAt', 'retainedHistory'].sort());
    expect(closed.body.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(JSON.stringify(closed.body)).not.toMatch(/closureId|userId|auditLogId|reasonCode|retentionPolicyVersion/);
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
    expect(closure).toMatchObject({ reasonCode: 'SERVICE_NO_LONGER_NEEDED', retentionPolicyVersion: eligibility.body.retentionPolicyVersion }); expect(audit.details).toMatchObject({ closureId: closure.id });
    await expect(db.accountClosure.update({ where: { id: closure.id }, data: { reasonCode: 'PRICE' } })).rejects.toThrow();
    await expect(db.accountClosure.delete({ where: { id: closure.id } })).rejects.toThrow();

    const admin = new Client(); await admin.login(await account('ADMIN'));
    const restoreBody = { expectedDisabledAt: user.disabledAt!.toISOString(), confirmation: fixture.user.displayName, reason: '本人確認後に元の会員だけを復旧する結合試験' };
    expect((await admin.call(`admin/account-closures/${closure.id}/restore`, 'POST', restoreBody, undefined, { 'Idempotency-Key': randomUUID() })).status).toBe(403);
    expect((await admin.call('admin/account-closures')).status).toBe(403); await admin.mfa();
    const records = await admin.call('admin/account-closures'); expect(records.status).toBe(200);
    expect(records.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: closure.id, status: 'CLOSED', retentionPolicyVersion: eligibility.body.retentionPolicyVersion })]));
    expect(Object.keys(records.body).sort()).toEqual(['items', 'limit', 'page', 'total'].sort());
    const record = records.body.items.find((item: { id: string }) => item.id === closure.id);
    expect(Object.keys(record).sort()).toEqual(['accessRevokedAt', 'id', 'reasonCode', 'requestedAt', 'retentionPolicyVersion', 'status', 'user'].sort());
    expect(Object.keys(record.user).sort()).toEqual(['disabledAt', 'displayName', 'email', 'id', 'registrationMethod'].sort());
    expect(JSON.stringify(records.body)).not.toMatch(/passwordHash|mfaSecret|tokenHash/);

    const wrongConfirmation = await admin.call(`admin/account-closures/${closure.id}/restore`, 'POST', { ...restoreBody, confirmation: '別の会員' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(wrongConfirmation).toMatchObject({ status: 400, body: { code: 'ACCOUNT_RESTORE_CONFIRMATION_MISMATCH' } });
    const restoreKey = randomUUID();
    const restored = await admin.call(`admin/account-closures/${closure.id}/restore`, 'POST', restoreBody, undefined, { 'Idempotency-Key': restoreKey });
    expect(restored).toMatchObject({ status: 201, body: { closureId: closure.id, lineLoginRestored: true, notificationsRemainDisabled: true, entitlementsRestored: false, referralChanged: false } });
    expect(Object.keys(restored.body).sort()).toEqual(['closureId', 'entitlementsRestored', 'lineLoginRestored', 'notificationsRemainDisabled', 'referralChanged', 'restoredAt'].sort());
    expect((await admin.call(`admin/account-closures/${closure.id}/restore`, 'POST', restoreBody, undefined, { 'Idempotency-Key': restoreKey })).body).toEqual(restored.body);
    expect((await admin.call(`admin/account-closures/${closure.id}/restore`, 'POST', restoreBody, undefined, { 'Idempotency-Key': randomUUID() })).body.code).toBe('ACCOUNT_ALREADY_RESTORED');

    const [restoredUser, restoredLine, restoredPreferences, preservedClosure, preservedEntitlement, restoreAudit] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: fixture.user.id } }), db.lineAccount.findUniqueOrThrow({ where: { userId: fixture.user.id } }),
      db.notificationPreference.findUniqueOrThrow({ where: { userId: fixture.user.id } }), db.accountClosure.findUniqueOrThrow({ where: { id: closure.id } }),
      db.entitlement.findUniqueOrThrow({ where: { id: entitlement.id } }), db.auditLog.findFirstOrThrow({ where: { targetId: fixture.user.id, action: 'ACCOUNT_RESTORED' } })
    ]);
    expect(restoredUser.disabledAt).toBeNull(); expect(restoredLine.unlinkedAt).toBeNull(); expect(restoredLine.notificationDisabledAt).not.toBeNull();
    expect(restoredPreferences).toMatchObject({ predictions: false, changes: false, articles: false, billing: false });
    expect(preservedClosure.id).toBe(closure.id); expect(preservedEntitlement.revokedAt).not.toBeNull(); expect(restoreAudit.details).toMatchObject({ closureId: closure.id, referralChanged: false });
    expect((await new Client().login(fixture)).status).toBe(201);
    const afterRestore = await admin.call('admin/account-closures');
    expect(afterRestore.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: closure.id, status: 'RESTORED', user: expect.objectContaining({ disabledAt: null }) })]));
  });

  it('does not close a member while paid access is still active', async () => {
    const fixture = await account(); const now = new Date(); const endsAt = new Date(now.getTime() + 86400000);
    const entitlement = await db.entitlement.create({ data: { userId: fixture.user.id, planCode: 'STANDARD', startsAt: now, endsAt, reason: '退会ブロック試験', grantedBy: fixture.user.id } });
    await db.subscription.create({ data: { userId: fixture.user.id, planCode: 'STANDARD', status: 'ACTIVE', priceYen: 2980, currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, provider: 'LOCAL_TEST', providerSubscriptionId: `closure-sub-${randomUUID()}`, entitlementId: entitlement.id } });
    const client = new Client(); await client.login(fixture);
    const eligibility = await client.call('me/closure'); expect(eligibility.body.eligible).toBe(false); expect(eligibility.body.blockers[0].code).toBe('ACTIVE_SUBSCRIPTION');
    expect(Object.keys(eligibility.body.blockers[0]).sort()).toEqual(['code', 'endsAt', 'href', 'message'].sort());
    const response = await client.call('me/close', 'POST', { reasonCode: 'PRICE', confirmation: '退会する', currentPassword: fixture.password });
    expect(response.status).toBe(409); expect(response.body.code).toBe('ACTIVE_BILLING_EXISTS');
    expect((await client.call('me')).status).toBe(200); expect(await db.accountClosure.findUnique({ where: { userId: fixture.user.id } })).toBeNull();
  });

  it('does not close a member while a Stripe checkout can still be paid', async () => {
    const fixture = await account();
    await db.billingCheckout.create({ data: {
      userId: fixture.user.id,
      kind: 'SUBSCRIPTION',
      planCode: 'STANDARD',
      baseAmountYen: 2980,
      amountYen: 2980,
      recurringAmountYen: 2980,
      status: 'OPEN',
      idempotencyKey: `closure-open-checkout:${fixture.user.id}:${randomUUID()}`,
      requestHash: 'closure-open-checkout',
      providerSessionId: `cs_test_${randomUUID()}`,
      providerCheckoutUrl: 'https://checkout.stripe.test/session',
      expiresAt: new Date(Date.now() + 30 * 60000)
    } });
    const client = new Client(); await client.login(fixture);
    const eligibility = await client.call('me/closure');
    expect(eligibility.body).toMatchObject({ eligible: false, blockers: [expect.objectContaining({ code: 'PENDING_CHECKOUT' })] });
    const response = await client.call('me/close', 'POST', { reasonCode: 'PRICE', confirmation: '退会する', currentPassword: fixture.password });
    expect(response).toMatchObject({ status: 409, body: { code: 'ACTIVE_BILLING_EXISTS' } });
    expect(await db.accountClosure.findUnique({ where: { userId: fixture.user.id } })).toBeNull();
  });

  it('requires administrator AAL2 and records a versioned retention policy without executing anonymization', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/account-closures/retention-policy')).status).toBe(403);
    expect((await admin.call('admin/account-closures/retention-preview')).status).toBe(403);
    await admin.mfa();
    const version = `privacy-${randomUUID()}`;
    const input = { version, identityRetentionDays: 365, networkIdentifierRetentionDays: 90, anonymizationScope: ['EMAIL', 'DISPLAY_NAME', 'AUTH_IDENTITY', 'LINE_IDENTITY', 'NETWORK_IDENTIFIERS'], reRegistrationHandling: 'MANUAL_REVIEW', dataRequestHandling: 'MANUAL_LEGAL_REVIEW', legalReviewReference: 'integration-legal-review', reason: '保持方針の結合試験' };
    const approved = await admin.call('admin/account-closures/retention-policy', 'POST', input);
    expect(approved.status).toBe(201); expect(approved.body).toMatchObject({ version, identityRetentionDays: 365, networkIdentifierRetentionDays: 90, anonymizationScope: input.anonymizationScope, reRegistrationHandling: 'MANUAL_REVIEW', dataRequestHandling: 'MANUAL_LEGAL_REVIEW', legalReviewReference: 'integration-legal-review', approvedBy: { id: expect.any(String), displayName: expect.any(String) } });
    expect(approved.body).not.toHaveProperty('reason');
    expect((await admin.call('admin/account-closures/retention-policy', 'POST', input)).status).toBe(409);
    const status = await admin.call('admin/account-closures/retention-policy');
    expect(status).toMatchObject({ status: 200, body: { current: { version }, dryRun: { eligibleClosures: expect.any(Number) }, unmappedClosures: expect.any(Number), executionEnabled: false } });
    const preview = await admin.call('admin/account-closures/retention-preview');
    expect(preview).toMatchObject({ status: 200, body: { items: expect.any(Array), total: expect.any(Number), page: 1, limit: 20, automaticExecution: false } });
    expect(preview.body.items.some((item: { policyVersion: string; status: string }) => item.policyVersion === 'development-v1' && item.status === 'POLICY_UNMAPPED')).toBe(true);
    expect(JSON.stringify(preview.body)).not.toMatch(/passwordHash|authSubject|lineSubject|mfaSecret/);
    const member = new Client(); await member.login(await account());
    expect((await member.call('me/closure')).body.retentionPolicyVersion).toBe(version);
  });
});
