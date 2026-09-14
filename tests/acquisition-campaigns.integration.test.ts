import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { account, base, Client, db, origin } from './helpers';

afterAll(() => db.$disconnect());

describe('acquisition campaign operations', () => {
  it('issues audited registration URLs and exports aggregate-only CSV', async () => {
    const adminFixture = await account('ADMIN'); const admin = new Client(); await admin.login(adminFixture); await admin.mfa();
    const code = `launch_${randomUUID().slice(0, 8)}`;
    const input = { name: '秋開催LP', code: code.toUpperCase(), source: ' LP ', medium: ' Owned ', content: 'hero', landingPath: '/register', referralCode: 'staff_01', reason: '結合試験で登録URLを発行' };
    const created = await admin.call('admin/acquisition/campaigns', 'POST', input);
    expect(created.status).toBe(201); expect(created.body).toMatchObject({ name: '秋開催LP', code, source: 'lp', medium: 'owned' });
    const url = new URL(created.body.registrationUrl); expect(url.origin).toBe(new URL(origin).origin); expect(url.pathname).toBe('/register'); expect(Object.fromEntries(url.searchParams)).toEqual({ utm_source: 'lp', utm_medium: 'owned', utm_campaign: code, utm_content: 'hero', ref: 'staff_01' });
    expect((await admin.call('admin/acquisition/campaigns', 'POST', input)).status).toBe(409);
    expect(await db.auditLog.count({ where: { action: 'ACQUISITION_CAMPAIGN_CREATE', targetId: created.body.id } })).toBe(1);

    const member = await account(); await db.memberAcquisition.create({ data: { userId: member.user.id, source: '=formula', medium: 'test', campaign: code } });
    const report = await admin.call('admin/acquisition?days=30'); expect(report.status).toBe(200); expect(report.body.campaigns).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.id, registrationUrl: created.body.registrationUrl })]));
    const csv = await fetch(`${base}/api/v1/admin/acquisition/export.csv?days=30`, { headers: { Cookie: admin.cookie, Origin: origin } });
    const text = await csv.text(); expect(csv.status).toBe(200); expect(csv.headers.get('content-type')).toContain('text/csv'); expect(csv.headers.get('content-disposition')).toContain('acquisition-30days.csv'); expect(text).toContain('無料登録数'); expect(text).toContain("'=formula"); expect(text).not.toContain(member.user.email!);

    const ordinary = new Client(); await ordinary.login(await account()); expect((await ordinary.call('admin/acquisition?days=30')).status).toBe(403); expect((await ordinary.call('admin/acquisition/campaigns', 'POST', input)).status).toBe(403);
  });
});
