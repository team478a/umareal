import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('staff role management', () => {
  it('requires administrator AAL2 and changes a verified account role with session revocation and audit', async () => {
    const actorFixture = await account('ADMIN'); const actor = new Client(); await actor.login(actorFixture);
    expect((await actor.call('admin/staff')).body.code).toBe('MFA_REQUIRED');
    await actor.mfa();

    const candidateFixture = await account('MEMBER'); const candidate = new Client(); await candidate.login(candidateFixture);
    const list = await actor.call('admin/staff');
    expect(list.status).toBe(200);
    expect(list.body.accounts.find((item: { id: string }) => item.id === candidateFixture.user.id)).toMatchObject({ role: 'MEMBER', dependencies: { upcomingRaceAssignments: 0, activeWin5Products: 0 } });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|mfaSecret|pendingMfa|tokenHash/);

    const mismatch = await actor.call(`admin/staff/${candidateFixture.user.id}/role`, 'PATCH', { expectedRole: 'MEMBER', nextRole: 'EXPERT', confirmationEmail: 'different@example.test', reason: '専門家として業務開始' });
    expect(mismatch).toMatchObject({ status: 409, body: { code: 'STAFF_CONFIRMATION_MISMATCH' } });

    const changed = await actor.call(`admin/staff/${candidateFixture.user.id}/role`, 'PATCH', { expectedRole: 'MEMBER', nextRole: 'EXPERT', confirmationEmail: candidateFixture.user.email, reason: '専門家として業務開始' });
    expect(changed).toMatchObject({ status: 200, body: { previousRole: 'MEMBER', nextRole: 'EXPERT', mfaEnrollmentRequired: true } });
    expect((await candidate.call('me')).status).toBe(401);
    await candidate.login(candidateFixture);
    expect((await candidate.call('me')).body).toMatchObject({ role: 'EXPERT', aal: 1, mfaRequired: true });
    expect(await db.auditLog.count({ where: { actorId: actorFixture.user.id, targetId: candidateFixture.user.id, action: 'STAFF_ROLE_CHANGED', reason: '専門家として業務開始' } })).toBe(1);

    const stale = await actor.call(`admin/staff/${candidateFixture.user.id}/role`, 'PATCH', { expectedRole: 'MEMBER', nextRole: 'OPERATOR', confirmationEmail: candidateFixture.user.email, reason: '古い画面からの変更' });
    expect(stale).toMatchObject({ status: 409, body: { code: 'STAFF_ROLE_CHANGED' } });

    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/staff')).status).toBe(403);
    const administratorChange = await actor.call(`admin/staff/${actorFixture.user.id}/role`, 'PATCH', { expectedRole: 'MEMBER', nextRole: 'OPERATOR', confirmationEmail: actorFixture.user.email, reason: '管理者を直接変更' });
    expect(administratorChange).toMatchObject({ status: 409, body: { code: 'STAFF_ADMIN_MANAGED_SEPARATELY' } });

    const payingMember = await account('MEMBER');
    await db.billingCheckout.create({ data: { userId: payingMember.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', amountYen: 2980, status: 'OPEN', idempotencyKey: `staff-open-checkout:${payingMember.user.id}:${randomUUID()}`, requestHash: 'staff-open-checkout', providerSessionId: `cs_test_${randomUUID()}`, providerCheckoutUrl: 'https://checkout.stripe.test/session', expiresAt: new Date(Date.now() + 30 * 60000) } });
    const payingMemberChange = await actor.call(`admin/staff/${payingMember.user.id}/role`, 'PATCH', { expectedRole: 'MEMBER', nextRole: 'EDITOR', confirmationEmail: payingMember.user.email, reason: '決済中の権限変更を拒否' });
    expect(payingMemberChange).toMatchObject({ status: 409, body: { code: 'STAFF_ACTIVE_MEMBER_ACCESS' } });
    expect((await db.user.findUniqueOrThrow({ where: { id: payingMember.user.id } })).role).toBe('MEMBER');
  });

  it('protects an expert role while future race or active WIN5 responsibility remains', async () => {
    const actorFixture = await account('ADMIN'); const actor = new Client(); await actor.login(actorFixture); await actor.mfa();
    const expertFixture = await account('EXPERT');
    const nextExpertFixture = await account('EXPERT');
    const suffix = Math.random().toString(36).slice(2, 9);
    const existingTargetDates = new Set((await db.predictionProduct.findMany({ where: { type: 'WIN5_PREVIEW' }, select: { targetDate: true } })).map(item => item.targetDate));
    let future = new Date(Date.now() + 3 * 86400000);
    let targetDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(future);
    while (existingTargetDates.has(targetDate)) {
      future = new Date(future.getTime() + 86400000);
      targetDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(future);
    }
    const race = await db.race.create({ data: { raceDate: targetDate, venue: `権限${suffix}`, number: 1, name: '担当解除保護', startsAt: future, status: 'SCHEDULED' } });
    await db.expertAssignment.create({ data: { raceId: race.id, userId: expertFixture.user.id } });
    const product = await db.predictionProduct.create({ data: { targetDate, title: '担当解除保護WIN5', expertId: expertFixture.user.id, scheduledPublishAt: new Date(Date.now() + 3600000), confidence: 'B', updatedBy: actorFixture.user.id } });

    const blocked = await actor.call(`admin/staff/${expertFixture.user.id}/role`, 'PATCH', { expectedRole: 'EXPERT', nextRole: 'MEMBER', confirmationEmail: expertFixture.user.email, reason: '担当終了' });
    expect(blocked).toMatchObject({ status: 409, body: { code: 'STAFF_EXPERT_STILL_ASSIGNED' } });
    expect((await db.user.findUniqueOrThrow({ where: { id: expertFixture.user.id } })).role).toBe('EXPERT');

    const staleTransfer = await actor.call(`admin/staff/${expertFixture.user.id}/responsibilities`, 'PATCH', { nextExpertId: nextExpertFixture.user.id, expectedUpcomingRaceAssignments: 0, expectedActiveWin5Products: 1, confirmationEmail: expertFixture.user.email, reason: '古い担当件数' });
    expect(staleTransfer).toMatchObject({ status: 409, body: { code: 'STAFF_DEPENDENCIES_CHANGED' } });
    const transfer = await actor.call(`admin/staff/${expertFixture.user.id}/responsibilities`, 'PATCH', { nextExpertId: nextExpertFixture.user.id, expectedUpcomingRaceAssignments: 1, expectedActiveWin5Products: 1, confirmationEmail: expertFixture.user.email, reason: '次回開催から担当交代' });
    expect(transfer).toMatchObject({ status: 200, body: { sourceExpertId: expertFixture.user.id, nextExpert: { id: nextExpertFixture.user.id }, upcomingRaceAssignments: 1, activeWin5Products: 1 } });
    expect(await db.expertAssignment.findUnique({ where: { raceId_userId: { raceId: race.id, userId: expertFixture.user.id } } })).toBeNull();
    expect(await db.expertAssignment.findUnique({ where: { raceId_userId: { raceId: race.id, userId: nextExpertFixture.user.id } } })).not.toBeNull();
    expect(await db.predictionProduct.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ expertId: nextExpertFixture.user.id, revision: 2 });
    expect(await db.auditLog.count({ where: { actorId: actorFixture.user.id, targetId: expertFixture.user.id, action: 'STAFF_RESPONSIBILITIES_TRANSFERRED', reason: '次回開催から担当交代' } })).toBe(1);
    const changed = await actor.call(`admin/staff/${expertFixture.user.id}/role`, 'PATCH', { expectedRole: 'EXPERT', nextRole: 'MEMBER', confirmationEmail: expertFixture.user.email, reason: '担当移管を確認して終了' });
    expect(changed).toMatchObject({ status: 200, body: { previousRole: 'EXPERT', nextRole: 'MEMBER' } });
  });

  it('suspends and restores staff without changing role or member settings, and protects active access', async () => {
    const actorFixture = await account('ADMIN'); const actor = new Client(); await actor.login(actorFixture); await actor.mfa();
    const operatorFixture = await account('OPERATOR'); const operator = new Client(); await operator.login(operatorFixture);
    const beforePreferences = await db.notificationPreference.findUniqueOrThrow({ where: { userId: operatorFixture.user.id } });
    const suspended = await actor.call(`admin/staff/${operatorFixture.user.id}/status`, 'PATCH', { action: 'SUSPEND', expectedRole: 'OPERATOR', confirmationEmail: operatorFixture.user.email, reason: '運営業務から一時離任' });
    expect(suspended).toMatchObject({ status: 200, body: { userId: operatorFixture.user.id, role: 'OPERATOR', status: 'SUSPENDED' } });
    expect((await operator.call('me')).status).toBe(401);
    expect((await operator.login(operatorFixture).catch(() => null))).toBeNull();
    expect(await db.user.findUniqueOrThrow({ where: { id: operatorFixture.user.id } })).toMatchObject({ role: 'OPERATOR', disabledAt: expect.any(Date) });
    expect(await db.notificationPreference.findUniqueOrThrow({ where: { userId: operatorFixture.user.id } })).toMatchObject({ predictions: beforePreferences.predictions, changes: beforePreferences.changes, articles: beforePreferences.articles, billing: beforePreferences.billing });

    const listed = await actor.call('admin/staff');
    expect(listed.body.accounts.find((item: { id: string }) => item.id === operatorFixture.user.id)).toMatchObject({ role: 'OPERATOR', disabledAt: expect.any(String) });
    const restored = await actor.call(`admin/staff/${operatorFixture.user.id}/status`, 'PATCH', { action: 'RESTORE', expectedRole: 'OPERATOR', confirmationEmail: operatorFixture.user.email, reason: '運営業務へ復帰' });
    expect(restored).toMatchObject({ status: 200, body: { role: 'OPERATOR', status: 'ACTIVE' } });
    await operator.login(operatorFixture);
    expect((await operator.call('me')).body).toMatchObject({ role: 'OPERATOR' });
    expect(await operator.call('billing/checkout', 'POST', { planCode: 'STANDARD' })).toMatchObject({ status: 403, body: { code: 'MEMBER_REQUIRED' } });
    expect(await db.auditLog.count({ where: { targetId: operatorFixture.user.id, action: { in: ['STAFF_ACCOUNT_SUSPENDED', 'STAFF_ACCOUNT_RESTORED'] } } })).toBe(2);

    const editorFixture = await account('EDITOR'); const now = new Date();
    await db.entitlement.create({ data: { userId: editorFixture.user.id, planCode: 'MANUAL_TEST', startsAt: new Date(now.getTime() + 3600000), endsAt: new Date(now.getTime() + 86400000), reason: '将来閲覧権限の停止保護', grantedBy: actorFixture.user.id } });
    const protectedAccess = await actor.call(`admin/staff/${editorFixture.user.id}/status`, 'PATCH', { action: 'SUSPEND', expectedRole: 'EDITOR', confirmationEmail: editorFixture.user.email, reason: '利用停止試験' });
    expect(protectedAccess).toMatchObject({ status: 409, body: { code: 'STAFF_ACTIVE_MEMBER_ACCESS' } });
    expect((await db.user.findUniqueOrThrow({ where: { id: editorFixture.user.id } })).disabledAt).toBeNull();

    const scheduledOperator = await account('OPERATOR'); const suffix = Math.random().toString(36).slice(2, 9); const startsAt = new Date(Date.now() + 86400000);
    const race = await db.race.create({ data: { raceDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(startsAt), venue: `予約${suffix}`, number: 1, name: '配信予約保護', startsAt } });
    await db.publicationSchedule.create({ data: { raceId: race.id, kind: 'RACE_ANNOUNCEMENT', draftRevision: null, scheduledAt: new Date(Date.now() + 3600000), reason: '配信予約保護', createdBy: scheduledOperator.user.id } });
    const roleBlocked = await actor.call(`admin/staff/${scheduledOperator.user.id}/role`, 'PATCH', { expectedRole: 'OPERATOR', nextRole: 'MEMBER', confirmationEmail: scheduledOperator.user.email, reason: '予約を残した変更' });
    expect(roleBlocked).toMatchObject({ status: 409, body: { code: 'STAFF_SCHEDULES_PENDING' } });
  });
});
