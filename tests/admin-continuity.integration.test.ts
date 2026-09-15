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
});
