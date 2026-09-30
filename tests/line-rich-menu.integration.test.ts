import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLineRichMenuResponseSchema, publishLineRichMenuResponseSchema } from '../packages/domain/src';
import { account, base, Client, db, origin } from './helpers';

beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const richMenuTransport = process.env.LINE_RICH_MENU_TRANSPORT ?? process.env.NOTIFICATION_TRANSPORT;
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local' || richMenuTransport !== 'test') throw new Error('LINE rich menu integration is limited to the local test transport');
});
afterAll(() => db.$disconnect());

describe('LINE rich menu administration', () => {
  it('requires ADMIN with AAL2 and never returns credentials', async () => {
    expect((await new Client().call('admin/line-rich-menu')).status).toBe(401);
    const member = new Client(); await member.login(await account('MEMBER'));
    expect((await member.call('admin/line-rich-menu')).status).toBe(403);
    const aal1 = new Client(); await aal1.login(await account('ADMIN'));
    const aal1Result = await aal1.call('admin/line-rich-menu');
    expect(aal1Result.status).toBe(403); expect(aal1Result.body.code).toBe('MFA_REQUIRED');

    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const response = await admin.call('admin/line-rich-menu');
    expect(response.status).toBe(200);
    const summary = adminLineRichMenuResponseSchema.parse(response.body);
    expect(summary.transport).toBe('TEST_ONLY');
    expect(summary.menu.items).toHaveLength(6);
    for (const item of summary.menu.items) expect(new URL(item.url).origin).toBe(new URL(origin).origin);
    const serialized = JSON.stringify(response.body);
    for (const field of ['lineAccessToken', 'lineAccessTokenEncrypted', 'email', 'authSubject', 'token', 'secret']) expect(serialized).not.toContain(`"${field}"`);

    const preview = await fetch(`${base}/api/v1/admin/line-rich-menu/preview`, { headers: { Cookie: admin.cookie, Origin: origin } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await preview.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
  });

  it('publishes idempotently against the reviewed baseline and preserves completed history', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const summary = adminLineRichMenuResponseSchema.parse((await admin.call('admin/line-rich-menu')).body);
    const baseline = summary.currentPublication?.id ?? null;
    const results = await Promise.all([
      admin.call('admin/line-rich-menu/publish', 'POST', { currentPublicationId: baseline, reason: '同時公開試験 A' }),
      admin.call('admin/line-rich-menu/publish', 'POST', { currentPublicationId: baseline, reason: '同時公開試験 B' })
    ]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const publishedResult = results.find(result => result.status === 201)!;
    const published = publishLineRichMenuResponseSchema.parse(publishedResult.body);
    expect(published.transport).toBe('TEST_ONLY');
    expect(published.publication).toMatchObject({ status: 'PUBLISHED', errorCode: null });
    expect(published.publication.providerRichMenuId).toMatch(/^test-richmenu-/);
    expect(await db.lineRichMenuPublication.count({ where: { id: published.publication.id, status: 'PUBLISHED' } })).toBe(1);
    expect(await db.auditLog.findFirst({ where: { action: 'LINE_RICH_MENU_PUBLISHED', targetType: 'LINE_RICH_MENU', targetId: published.publication.id } })).not.toBeNull();

    await expect(db.lineRichMenuPublication.update({ where: { id: published.publication.id }, data: { reason: '改ざん' } })).rejects.toThrow();
    await expect(db.lineRichMenuPublication.delete({ where: { id: published.publication.id } })).rejects.toThrow();
    expect(await db.lineRichMenuPublication.findUniqueOrThrow({ where: { id: published.publication.id } })).toMatchObject({ reason: expect.stringMatching(/^同時公開試験/), status: 'PUBLISHED' });

    const stale = await admin.call('admin/line-rich-menu/publish', 'POST', { currentPublicationId: baseline, reason: '古い画面からの公開試験' });
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('LINE_RICH_MENU_STALE');
  });
});
