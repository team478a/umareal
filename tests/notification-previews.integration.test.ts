import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';

const admin = new Client();
let raceId = '';

beforeAll(async () => {
  if (process.env.AUTH_PROVIDER !== 'local' || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Local test database required');
  await admin.login(await account('ADMIN'));
  const suffix = randomUUID().slice(0, 8);
  const race = await db.race.create({ data: { raceDate: '2099-12-19', venue: `確認${suffix}`, number: 8, name: `配信前確認${suffix}`, startsAt: new Date('2099-12-19T15:00:00+09:00') } });
  raceId = race.id;
  const lineMember = await account('MEMBER');
  await db.lineAccount.create({ data: { userId: lineMember.user.id, subject: `preview-${suffix}` } });
});

afterAll(() => db.$disconnect());

describe('race announcement delivery preview', () => {
  it('requires an authorized AAL2 administrator', async () => {
    expect((await admin.call(`admin/notifications/previews/race-announcement?raceId=${raceId}`)).body.code).toBe('MFA_REQUIRED');
    await admin.mfa();
  });

  it('shows the exact current channel audience, safe message, and schedule without creating a publication', async () => {
    const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    const base = { disabledAt: null, preferences: { is: { predictions: true } } } as const;
    const lineWhere = { ...base, lineAccount: { is: { notificationDisabledAt: null, unlinkedAt: null } } };
    const emailWhere = { ...base, email: { not: null }, emailVerifiedAt: { not: null }, emailDeliveryDisabledAt: null, preferences: { is: { predictions: true, emailEnabled: true } } };
    const [line, email, both] = await db.$transaction([
      db.user.count({ where: lineWhere }), db.user.count({ where: emailWhere }), db.user.count({ where: { AND: [lineWhere, emailWhere] } })
    ]);
    const lineScheduled = settings.lineNotificationsEnabled ? line : 0; const emailScheduled = settings.emailNotificationsEnabled ? email : 0;
    const unique = lineScheduled + emailScheduled - (settings.lineNotificationsEnabled && settings.emailNotificationsEnabled ? both : 0);
    const plannedAt = '2099-12-19T14:30:00+09:00';
    const before = await db.$transaction([db.raceAnnouncement.count({ where: { raceId } }), db.notificationEvent.count()]);
    const response = await admin.call(`admin/notifications/previews/race-announcement?raceId=${raceId}&scheduledAt=${encodeURIComponent(plannedAt)}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      eventType: 'RACE_ANNOUNCED', contentLabel: '対象レース告知', timing: 'SCHEDULED', version: 1,
      audience: { uniqueMembers: unique, totalDeliveries: lineScheduled + emailScheduled, duplicateChannelMembers: settings.lineNotificationsEnabled && settings.emailNotificationsEnabled ? both : 0, line: { enabled: settings.lineNotificationsEnabled, eligibleRecipients: line, scheduledDeliveries: lineScheduled }, email: { enabled: settings.emailNotificationsEnabled, eligibleRecipients: email, scheduledDeliveries: emailScheduled } },
      message: { type: 'text' }
    });
    expect(response.body.plannedAt).toBe(new Date(plannedAt).toISOString());
    expect(response.body.message.text).toContain('予想対象レースのお知らせ');
    expect(response.body.message.text).toContain('/races/');
    expect(response.body.message.text).not.toMatch(/買い目|本命|評価理由/);
    expect(JSON.stringify(response.body)).not.toMatch(/@example\.test|passwordHash|tokenHash|subject/);
    expect(await db.$transaction([db.raceAnnouncement.count({ where: { raceId } }), db.notificationEvent.count()])).toEqual(before);
  });

  it('rejects previews at or after the server-owned race deadline', async () => {
    const response = await admin.call(`admin/notifications/previews/race-announcement?raceId=${raceId}&scheduledAt=${encodeURIComponent('2099-12-19T15:00:00+09:00')}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PREVIEW_AFTER_DEADLINE');
  });
});
