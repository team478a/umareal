import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('free-member onboarding funnel', () => {
  it('records server-owned milestones and returns only aggregate cohort data to AAL2 admins', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const source = `onboarding-${randomUUID()}`;
    const fixture = await account();
    await db.memberAcquisition.create({ data: { userId: fixture.user.id, source, medium: 'integration', campaign: 'free-registration' } });
    const member = new Client(); await member.login(fixture);
    expect(await db.memberJourneyEvent.count({ where: { userId: fixture.user.id, eventType: 'FIRST_LOGIN' } })).toBe(1);

    expect((await member.call('me/journey', 'POST', { eventType: 'LINE_GUIDANCE_VIEWED' })).status).toBe(201);
    expect((await member.call('me/journey', 'POST', { eventType: 'LINE_GUIDANCE_VIEWED' })).status).toBe(201);
    await db.lineAccount.create({ data: { userId: fixture.user.id, subject: `onboarding-${randomUUID()}` } });

    const response = await admin.call(`admin/onboarding-funnel?days=30&source=${encodeURIComponent(source)}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ days: 30, source, paid: 0 });
    expect(response.body.sources).toContain(source);
    expect(response.body.stages.map((stage: { key: string; value: number }) => [stage.key, stage.value])).toEqual([
      ['REGISTERED', 1], ['IDENTITY_READY', 1], ['FIRST_LOGIN', 1], ['LINE_GUIDANCE_VIEWED', 1], ['LINE_READY', 1]
    ]);
    expect(response.body.stages.every((stage: { rateFromRegistered: number }) => stage.rateFromRegistered === 100)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(fixture.user.email);
    expect(JSON.stringify(response.body)).not.toContain(fixture.user.id);
    await expect(db.memberJourneyEvent.update({ where: { userId_eventType: { userId: fixture.user.id, eventType: 'FIRST_LOGIN' } }, data: { occurredAt: new Date(0) } })).rejects.toThrow();

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/onboarding-funnel')).status).toBe(403);
    expect((await admin.call('admin/onboarding-funnel?days=0')).status).toBe(400);
  });
});
