import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('administrator continuity', () => {
  it('requires AAL2, verifies the target email, promotes atomically and revokes local sessions', async () => {
    const actorFixture = await account('ADMIN'); const actor = new Client(); await actor.login(actorFixture);
    expect((await actor.call('admin/continuity')).body.code).toBe('MFA_REQUIRED');
    await actor.mfa();

    const candidateFixture = await account('MEMBER'); const candidate = new Client(); await candidate.login(candidateFixture);
    const before = await actor.call('admin/continuity');
    expect(before.status).toBe(200);
    expect(before.body.policy).toMatchObject({ minimumAdministrators: 2, backupFactorPerAdministrator: true, customRecoveryCodes: false });
    expect(before.body.candidates.some((item: { id: string }) => item.id === candidateFixture.user.id)).toBe(true);
    expect(JSON.stringify(before.body)).not.toMatch(/passwordHash|mfaSecret|pendingMfa|tokenHash/);

    const mismatch = await actor.call(`admin/continuity/administrators/${candidateFixture.user.id}/promote`, 'POST', { confirmationEmail: 'different@example.test', reason: '予備管理者の準備' });
    expect(mismatch.status).toBe(409);

    const promoted = await actor.call(`admin/continuity/administrators/${candidateFixture.user.id}/promote`, 'POST', { confirmationEmail: candidateFixture.user.email, reason: '公開日の予備管理者として本人確認済み' });
    expect(promoted.status).toBe(201);
    expect(promoted.body).toMatchObject({ userId: candidateFixture.user.id, role: 'ADMIN', mfaEnrollmentRequired: true });
    expect((await candidate.call('me')).status).toBe(401);
    await candidate.login(candidateFixture);
    expect((await candidate.call('me')).body).toMatchObject({ role: 'ADMIN', aal: 1, mfaRequired: true });
    expect((await candidate.call('admin/summary')).body.code).toBe('MFA_REQUIRED');
    expect(await db.auditLog.count({ where: { actorId: actorFixture.user.id, targetId: candidateFixture.user.id, action: 'ADMIN_PROMOTED', reason: '公開日の予備管理者として本人確認済み' } })).toBe(1);
    await expect(db.user.update({ where: { id: candidateFixture.user.id }, data: { pendingExternalMfaKind: 'BACKUP' } })).rejects.toThrow();

    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/continuity')).status).toBe(403);
  });

  it('suspends, restores and demotes another administrator while preserving continuity and audit history', async () => {
    const actorFixture = await account('ADMIN'); const actor = new Client(); await actor.login(actorFixture); await actor.mfa();
    const targetFixture = await account('ADMIN'); const target = new Client(); await target.login(targetFixture);
    await account('ADMIN'); await account('ADMIN');

    const selfDemotion = await actor.call(`admin/continuity/administrators/${actorFixture.user.id}/demote`, 'PATCH', {
      nextRole: 'OPERATOR', confirmationEmail: actorFixture.user.email, reason: '自己変更拒否の確認'
    });
    expect(selfDemotion.status).toBe(409);
    expect(selfDemotion.body.code).toBe('ADMIN_SELF_CHANGE_FORBIDDEN');

    const suspended = await actor.call(`admin/continuity/administrators/${targetFixture.user.id}/status`, 'PATCH', {
      action: 'SUSPEND', confirmationEmail: targetFixture.user.email, reason: '端末交換中の一時停止'
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ userId: targetFixture.user.id, role: 'ADMIN', status: 'SUSPENDED' });
    expect((await target.call('me')).status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: targetFixture.user.id } })).role).toBe('ADMIN');

    const duringSuspension = await actor.call('admin/continuity');
    expect(duringSuspension.body.administrators.some((item: { id: string }) => item.id === targetFixture.user.id)).toBe(false);
    expect(duringSuspension.body.suspendedAdministrators.some((item: { id: string }) => item.id === targetFixture.user.id)).toBe(true);

    const restored = await actor.call(`admin/continuity/administrators/${targetFixture.user.id}/status`, 'PATCH', {
      action: 'RESTORE', confirmationEmail: targetFixture.user.email, reason: '本人確認と端末交換が完了'
    });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ userId: targetFixture.user.id, role: 'ADMIN', status: 'ACTIVE' });
    await target.login(targetFixture);

    const demoted = await actor.call(`admin/continuity/administrators/${targetFixture.user.id}/demote`, 'PATCH', {
      nextRole: 'OPERATOR', confirmationEmail: targetFixture.user.email, reason: '運営担当へ職務変更'
    });
    expect(demoted.status).toBe(200);
    expect(demoted.body).toMatchObject({ userId: targetFixture.user.id, previousRole: 'ADMIN', nextRole: 'OPERATOR' });
    expect((await target.call('me')).status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: targetFixture.user.id } })).role).toBe('OPERATOR');
    expect(await db.auditLog.count({ where: { actorId: actorFixture.user.id, targetId: targetFixture.user.id, action: 'ADMIN_ACCOUNT_SUSPENDED', reason: '端末交換中の一時停止' } })).toBe(1);
    expect(await db.auditLog.count({ where: { actorId: actorFixture.user.id, targetId: targetFixture.user.id, action: 'ADMIN_ACCOUNT_RESTORED', reason: '本人確認と端末交換が完了' } })).toBe(1);
    expect(await db.auditLog.count({ where: { actorId: actorFixture.user.id, targetId: targetFixture.user.id, action: 'ADMIN_DEMOTED', reason: '運営担当へ職務変更' } })).toBe(1);
  });
});
