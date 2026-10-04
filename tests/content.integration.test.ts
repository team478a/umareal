import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runContentSchedules } from '../apps/worker/src/content-scheduler';
import { jstDate, publicContentDetailResponseSchema, publicContentListResponseSchema } from '../packages/domain/src';
import { account, Client, db } from './helpers';

let originalPolicy: unknown;
beforeAll(async () => {
  originalPolicy = (await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { contentAccessPolicy: true } })).contentAccessPolicy;
  await db.systemSetting.update({ where: { id: 'global' }, data: { contentAccessPolicy: { monthly: { paddock: true, win5: true, racePaper: true, content: true }, dayPass: { paddock: true, win5: true, racePaper: true, content: false }, manual: { paddock: true, win5: true, racePaper: true, content: true } } } });
});
afterAll(async () => { if (originalPolicy) await db.systemSetting.update({ where: { id: 'global' }, data: { contentAccessPolicy: originalPolicy as object } }); await db.$disconnect(); });

const draft = (title: string, visibility: 'PUBLIC' | 'MEMBERS' | 'PAID' = 'PUBLIC') => ({ kind: 'ARTICLE', title, summary: `${title}の概要`, body: `${title}の公開本文`, thumbnailUrl: null, mediaUrl: null, category: '検証記事', tags: ['検証'], visibility });

describe('content CMS publication and access', () => {
  it('enforces editor roles, publishes immutable versions, schedules and redacts paid bodies', async () => {
    const adminFixture = await account('ADMIN'); const admin = new Client(); await admin.login(adminFixture);
    expect((await admin.call('admin/content')).body.code).toBe('CONTENT_ACCESS_DENIED');
    await admin.mfa();
    const editorFixture = await account('EDITOR'); const editor = new Client(); await editor.login(editorFixture);
    expect((await editor.call('admin/content')).status).toBe(200);
    const notificationFixture = await account('MEMBER');
    const notificationClient = new Client(); await notificationClient.login(notificationFixture);
    const memberFixture = await account('MEMBER'); const member = new Client(); await member.login(memberFixture);
    expect((await member.call('admin/content')).status).toBe(403);

    const publicId = randomUUID();
    const saved = await editor.call('admin/content/draft', 'POST', { id: publicId, revision: 0, draft: draft('公開記事'), reason: '公開記事の下書き作成' });
    expect(saved).toMatchObject({ status: 201, body: { id: publicId, revision: 1, status: 'DRAFT' } });
    expect((await new Client().call(`content/${publicId}`)).status).toBe(404);
    const published = await editor.call(`admin/content/${publicId}/publish`, 'POST', { revision: 1, reason: '初版公開' });
    expect(published).toMatchObject({ status: 201, body: { status: 'PUBLISHED', version: 1, revision: 2 } });
    const publicVersion = await db.contentVersion.findFirstOrThrow({ where: { contentId: publicId, version: 1 } });
    const publicEvent = await db.notificationEvent.findUniqueOrThrow({ where: { contentVersionId: publicVersion.id } });
    expect(publicEvent).toMatchObject({ eventType: 'CONTENT_PUBLISHED', status: 'QUEUED', payload: { contentId: publicId, contentVersionId: publicVersion.id } });
    const webNotices = await notificationClient.call('me/notifications');
    expect(webNotices.body.items.find((item: { id: string }) => item.id === publicEvent.id)).toMatchObject({ content: { id: publicId, kind: 'ARTICLE', title: '公開記事', category: '検証記事' }, href: `/content/${publicId}` });
    const guestRead = publicContentDetailResponseSchema.parse((await new Client().call(`content/${publicId}`)).body);
    expect(guestRead).toMatchObject({ locked: false, body: '公開記事の公開本文' });
    const publicList = publicContentListResponseSchema.parse((await new Client().call('content?kind=ARTICLE&category=%E6%A4%9C%E8%A8%BC%E8%A8%98%E4%BA%8B')).body);
    expect(publicList.items.find(item => item.id === publicId)).toMatchObject({ locked: false, title: '公開記事' });

    const updated = await editor.call('admin/content/draft', 'POST', { id: publicId, revision: 2, draft: { ...draft('公開記事'), body: '第2版の本文', category: '未公開カテゴリ' }, reason: '本文更新' });
    expect(updated.body).toMatchObject({ revision: 3, status: 'DRAFT' });
    const oldCategory = publicContentListResponseSchema.parse((await new Client().call('content?category=%E6%A4%9C%E8%A8%BC%E8%A8%98%E4%BA%8B')).body);
    const unpublishedCategory = publicContentListResponseSchema.parse((await new Client().call('content?category=%E6%9C%AA%E5%85%AC%E9%96%8B%E3%82%AB%E3%83%86%E3%82%B4%E3%83%AA')).body);
    expect(oldCategory.items.some(item => item.id === publicId)).toBe(true);
    expect(unpublishedCategory.items.some(item => item.id === publicId)).toBe(false);
    expect((await editor.call(`admin/content/${publicId}/publish`, 'POST', { revision: 3, reason: '第2版公開' })).body.version).toBe(2);
    const versions = await db.contentVersion.findMany({ where: { contentId: publicId }, orderBy: { version: 'asc' } });
    expect(versions.map(item => item.version)).toEqual([1, 2]);
    expect(await db.notificationEvent.findUniqueOrThrow({ where: { contentVersionId: versions[1].id } })).toMatchObject({ eventType: 'CONTENT_UPDATED' });
    expect(JSON.stringify(versions[0].snapshot)).toContain('公開記事の公開本文');
    const changedKind = await editor.call('admin/content/draft', 'POST', { id: publicId, revision: 4, draft: { ...draft('公開記事'), kind: 'VIDEO', mediaUrl: 'https://example.test/video' }, reason: '種類変更試験' });
    expect(changedKind).toMatchObject({ status: 409, body: { code: 'CONTENT_KIND_FROZEN' } });
    await expect(db.contentVersion.update({ where: { id: versions[0].id }, data: { title: '改ざん' } })).rejects.toThrow();
    await expect(db.contentVersion.delete({ where: { id: versions[0].id } })).rejects.toThrow();

    const paidId = randomUUID();
    const paidSaved = await admin.call('admin/content/draft', 'POST', { id: paidId, revision: 0, draft: draft('有料記事', 'PAID'), reason: '有料記事の下書き' });
    await admin.call(`admin/content/${paidId}/publish`, 'POST', { revision: paidSaved.body.revision, reason: '有料記事公開' });
    const guestLocked = publicContentDetailResponseSchema.parse((await new Client().call(`content/${paidId}`)).body);
    expect(guestLocked.locked).toBe(true); expect(JSON.stringify(guestLocked)).not.toMatch(/公開本文|body|mediaUrl/);
    expect((await member.call(`content/${paidId}`)).body.locked).toBe(true);
    const now = new Date();
    const dayPassFixture = await account('MEMBER'); const dayPassMember = new Client(); await dayPassMember.login(dayPassFixture);
    await db.entitlement.create({ data: { userId: dayPassFixture.user.id, planCode: 'DAY_PASS', startsAt: new Date(now.getTime() - 1000), endsAt: new Date(now.getTime() + 3600000), raceDate: jstDate(new Date(guestLocked.publishedAt)), reason: 'CMS一日利用除外試験', grantedBy: adminFixture.user.id } });
    expect((await dayPassMember.call(`content/${paidId}`)).body.locked).toBe(true);
    await db.entitlement.create({ data: { userId: memberFixture.user.id, planCode: 'STANDARD', startsAt: new Date(now.getTime() - 1000), endsAt: new Date(now.getTime() + 3600000), raceDate: null, reason: 'CMS有料閲覧試験', grantedBy: adminFixture.user.id } });
    expect((await member.call(`content/${paidId}`)).body).toMatchObject({ locked: false, body: '有料記事の公開本文' });

    const scheduledId = randomUUID(); const scheduledAt = new Date(Date.now() + 60_000);
    const scheduledDraft = await editor.call('admin/content/draft', 'POST', { id: scheduledId, revision: 0, draft: { ...draft('予約動画', 'MEMBERS'), kind: 'VIDEO', mediaUrl: 'https://example.test/video' }, reason: '予約動画の下書き' });
    const scheduled = await editor.call(`admin/content/${scheduledId}/schedule`, 'POST', { revision: scheduledDraft.body.revision, scheduledAt: scheduledAt.toISOString(), reason: '予約公開試験' });
    expect(scheduled.body).toMatchObject({ status: 'SCHEDULED', revision: 2 });
    const run = await runContentSchedules({ db, now: () => new Date(scheduledAt.getTime() + 1000) });
    expect(run).toEqual({ claimed: 1, published: 1, failed: 0 });
    const scheduledVersion = await db.contentVersion.findFirstOrThrow({ where: { contentId: scheduledId, version: 1 } });
    expect(await db.notificationEvent.findUniqueOrThrow({ where: { contentVersionId: scheduledVersion.id } })).toMatchObject({ eventType: 'CONTENT_PUBLISHED' });
    expect((await member.call(`content/${scheduledId}`)).body).toMatchObject({ locked: false, mediaUrl: 'https://example.test/video' });

    const archived = await editor.call(`admin/content/${scheduledId}/archive`, 'POST', { revision: 3, reason: '掲載期間終了' });
    expect(archived.body.status).toBe('ARCHIVED');
    expect((await member.call(`content/${scheduledId}`)).status).toBe(404);
    expect((await editor.call(`admin/content/${scheduledId}/restore`, 'POST', { revision: 4, reason: '再編集' })).body.status).toBe('DRAFT');
    expect((await member.call(`content/${scheduledId}`)).status).toBe(404);
  });
});
