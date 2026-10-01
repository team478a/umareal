import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminFreeMemberBenefitListResponseSchema, adminFreeMemberBenefitResponseSchema, adminFreeReportAudioUploadResponseSchema, adminFreeReportDraftResponseSchema, adminFreeReportPublishResponseSchema, adminFreeReportRaceDetailResponseSchema, adminFreeReportRaceListResponseSchema, freeReportNotificationPreviewResponseSchema, publicFreeMemberBenefitListResponseSchema, publicFreeMemberBenefitResponseSchema, publicFreeMemberBenefitViewResponseSchema, publicFreeReportMetadataResponseSchema } from '../packages/domain/src';
import { runNotificationBatch } from '../apps/worker/src/notification-runner';
import type { NotificationTransport } from '../apps/worker/src/notification-runner';
import { account, base, Client, db, origin } from './helpers';

let lineSettingsBefore: { lineNotificationsEnabled: boolean; lineChannelId: string | null; lineChannelSecretEncrypted: string | null; lineAccessTokenEncrypted: string | null };
let benefitBefore: Awaited<ReturnType<typeof db.freeMemberBenefit.findUnique>>;
const createdBenefitIds: string[] = [];
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Integration suite is limited to a local development database');
  lineSettingsBefore = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineNotificationsEnabled: true, lineChannelId: true, lineChannelSecretEncrypted: true, lineAccessTokenEncrypted: true } });
  benefitBefore = await db.freeMemberBenefit.findUnique({ where: { id: 'global' } });
  await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: true, lineChannelId: 'free-report-test', lineChannelSecretEncrypted: 'test-encrypted', lineAccessTokenEncrypted: 'test-encrypted' } });
});
afterAll(async () => {
  await db.systemSetting.update({ where: { id: 'global' }, data: lineSettingsBefore });
  if (createdBenefitIds.length) {
    await db.freeMemberBenefitView.deleteMany({ where: { benefitId: { in: createdBenefitIds } } });
    await db.freeMemberBenefit.deleteMany({ where: { id: { in: createdBenefitIds } } });
  }
  if (benefitBefore) await db.freeMemberBenefit.upsert({ where: { id: 'global' }, create: benefitBefore, update: benefitBefore });
  else await db.freeMemberBenefit.deleteMany({ where: { id: 'global' } });
  await db.$disconnect();
});

async function fixture() {
  const suffix = randomUUID().slice(0, 8); const admin = await account('ADMIN'); const member = await account();
  const subject = `test:free-report:${suffix}`;
  await db.lineAccount.create({ data: { userId: member.user.id, subject } });
  const race = await db.race.create({ data: { raceDate: '2098-09-13', venue: `無料速報${suffix}`, number: 8, name: `無料速報試験${suffix}`, startsAt: new Date('2098-09-13T15:00:00+09:00') } });
  const firstHorse = await db.horse.create({ data: { id: randomUUID(), name: `上昇馬${suffix}` } });
  const secondHorse = await db.horse.create({ data: { id: randomUUID(), name: `下降馬${suffix}` } });
  const [up, down] = await Promise.all([
    db.raceEntry.create({ data: { raceId: race.id, horseId: firstHorse.id, number: 1, gate: 1, horseName: firstHorse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: '騎手A', trainer: '調教師A' } }),
    db.raceEntry.create({ data: { raceId: race.id, horseId: secondHorse.id, number: 2, gate: 2, horseName: secondHorse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: '騎手B', trainer: '調教師B' } })
  ]);
  const adminClient = new Client(); await adminClient.login(admin); await adminClient.mfa(); const memberClient = new Client(); await memberClient.login(member);
  return { admin, member, race, up, down, subject, adminClient, memberClient };
}

describe('LP free member offer', () => {
  it('publishes a safe append-only free report and sends its notification', async () => {
    const target = await fixture();
    expect((await new Client().call(`races/${target.race.id}/free-report`)).status).toBe(401);
    expect((await new Client().call(`admin/free-reports/races?date=${target.race.raceDate}`)).status).toBe(401);
    expect((await target.memberClient.call(`admin/free-reports/races?date=${target.race.raceDate}`)).status).toBe(403);
    expect((await new Client().call(`admin/free-reports/races/${target.race.id}`)).status).toBe(401);
    expect((await target.memberClient.call(`admin/free-reports/races/${target.race.id}`)).status).toBe(403);
    const adminRaceList = adminFreeReportRaceListResponseSchema.parse((await target.adminClient.call(`admin/free-reports/races?date=${target.race.raceDate}`)).body);
    expect(adminRaceList.items.find(item => item.id === target.race.id)).toMatchObject({ raceDate: target.race.raceDate, freeReportDraft: null, freeReportVersions: [] });
    expect(JSON.stringify(adminRaceList)).not.toMatch(/horseName|upReason|downReason|audioUrl|reviewText|updatedBy|password|token/i);
    const emptyAdminDetail = adminFreeReportRaceDetailResponseSchema.parse((await target.adminClient.call(`admin/free-reports/races/${target.race.id}`)).body);
    expect(emptyAdminDetail).toMatchObject({ id: target.race.id, freeReportDraft: null, freeReportVersions: [], resultVersions: [] });
    expect(emptyAdminDetail.entries).toHaveLength(2);
    const emptyMemberView = publicFreeReportMetadataResponseSchema.parse((await target.memberClient.call(`races/${target.race.id}/free-report`)).body);
    expect(emptyMemberView).toMatchObject({ race: { id: target.race.id, raceDate: target.race.raceDate }, versions: [] });
    const audioBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
    expect((await fetch(`${base}/api/v1/admin/free-reports/audio`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'audio/webm' }, body: audioBytes })).status).toBe(401);
    const uploadResponse = await fetch(`${base}/api/v1/admin/free-reports/audio`, { method: 'POST', headers: { Origin: origin, Cookie: target.adminClient.cookie, 'Content-Type': 'audio/webm' }, body: audioBytes });
    expect(uploadResponse.status).toBe(201); const upload = adminFreeReportAudioUploadResponseSchema.parse(await uploadResponse.json());
    expect(upload).toMatchObject({ sizeBytes: audioBytes.length, url: `/api/v1/free-report-audio/${upload.id}` });
    const beforePublish = await fetch(`${base}${upload.url}`, { headers: { Cookie: target.memberClient.cookie } });
    expect(beforePublish.status).toBe(404);
    const saved = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 0, upEntryId: target.up.id, upReason: '踏み込みが力強くなりました。', downEntryId: target.down.id, downReason: '発汗が目立ちます。', audioUrl: upload.url, reviewText: '', reason: '無料速報の結合試験' });
    expect(saved.status).toBe(200); const savedDraft = adminFreeReportDraftResponseSchema.parse(saved.body); expect(savedDraft.revision).toBe(1);
    expect(JSON.stringify(savedDraft)).not.toMatch(/password|token|email|raceEntry|creator/i);
    const savedAdminDetail = adminFreeReportRaceDetailResponseSchema.parse((await target.adminClient.call(`admin/free-reports/races/${target.race.id}`)).body);
    expect(savedAdminDetail.freeReportDraft).toMatchObject({ revision: 1, upEntryId: target.up.id, downEntryId: target.down.id, updatedBy: target.admin.user.id });
    const beforePreview = await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })]);
    const preview = await target.adminClient.call(`admin/notifications/previews/free-report?raceId=${target.race.id}&kind=PRE_RACE&revision=1&scheduledAt=${encodeURIComponent('2098-09-13T14:30:00+09:00')}`);
    expect(preview.status).toBe(200);
    const parsedPreview = freeReportNotificationPreviewResponseSchema.parse(preview.body);
    expect(parsedPreview).toMatchObject({ eventType: 'FREE_REPORT_PUBLISHED', contentLabel: '無料パドック速報', kind: 'PRE_RACE', draftRevision: 1, timing: 'SCHEDULED', version: 1 });
    expect(parsedPreview.audience.line.scheduledDeliveries).toBeGreaterThanOrEqual(1);
    expect(parsedPreview.message.text).toContain('無料パドック速報を公開しました');
    expect(parsedPreview.message.text).not.toContain(target.up.horseName);
    expect(JSON.stringify(parsedPreview)).not.toMatch(/upReason|downReason|audioUrl|reviewText|subject|password|token/i);
    expect(await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })])).toEqual(beforePreview);
    const stalePreview = await target.adminClient.call(`admin/notifications/previews/free-report?raceId=${target.race.id}&kind=PRE_RACE&revision=2`);
    expect(stalePreview.status).toBe(409); expect(stalePreview.body.code).toBe('FREE_REPORT_DRAFT_CONFLICT');
    const publishKey = randomUUID(); const published = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 1, kind: 'PRE_RACE', reason: '会員へ公開' }, undefined, { 'Idempotency-Key': publishKey });
    expect(published.status).toBe(201); const publishedBody = adminFreeReportPublishResponseSchema.parse(published.body); expect(publishedBody.kind).toBe('PRE_RACE');
    const replay = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 1, kind: 'PRE_RACE', reason: '会員へ公開' }, undefined, { 'Idempotency-Key': publishKey });
    expect(adminFreeReportPublishResponseSchema.parse(replay.body)).toEqual(publishedBody);
    const publishedAdminDetail = adminFreeReportRaceDetailResponseSchema.parse((await target.adminClient.call(`admin/free-reports/races/${target.race.id}`)).body);
    expect(publishedAdminDetail.freeReportVersions[0]).toMatchObject({ id: publishedBody.id, version: 1, kind: 'PRE_RACE', publishReason: '会員へ公開' });
    const memberView = await target.memberClient.call(`races/${target.race.id}/free-report`);
    expect(memberView.status).toBe(200); const memberViewBody = publicFreeReportMetadataResponseSchema.parse(memberView.body); expect(memberViewBody.versions[0]).toMatchObject({ kind: 'PRE_RACE', version: 1 });
    expect(JSON.stringify(memberViewBody)).not.toMatch(/upHorse|downHorse|Reason|audioUrl|reviewText|買い目|estimatedTotalYen|HONMEI/);
    const audioResponse = await fetch(`${base}${upload.url}`, { headers: { Cookie: target.memberClient.cookie, Range: 'bytes=0-3' } });
    expect(audioResponse.status).toBe(404);
    const version = await db.freeReportVersion.findUniqueOrThrow({ where: { id: publishedBody.id } });
    await expect(db.freeReportVersion.update({ where: { id: version.id }, data: { upReason: '上書き' } })).rejects.toThrow();
    await expect(db.freeReportVersion.delete({ where: { id: version.id } })).rejects.toThrow();
    await expect(db.audioAsset.update({ where: { id: upload.id }, data: { sizeBytes: 1 } })).rejects.toThrow();
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { freeReportVersionId: version.id } });
    const messages: string[] = []; const transport: NotificationTransport = { async send(input) { if (input.recipient === target.subject && input.targetId === version.id) messages.push(input.message.text); return { kind: 'SENT', providerMessageId: input.retryKey }; } };
    for (let index = 0; index < 20; index += 1) {
      const delivery = await db.notificationDelivery.findFirst({ where: { eventId: event.id, userId: target.member.user.id } });
      if (delivery?.status === 'SENT') break;
      if (delivery) await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
      await runNotificationBatch({ db, transport, limit: 200 });
    }
    expect(await db.notificationDelivery.findFirst({ where: { eventId: event.id, userId: target.member.user.id } })).toMatchObject({ status: 'SENT' });
    expect(messages[0]).toContain('無料パドック速報を公開しました');
    const notificationList = await target.memberClient.call('me/notifications?limit=50');
    expect(notificationList.body.items.find((item: { id: string }) => item.id === event.id)).toMatchObject({ title: '無料パドック速報を公開しました' });
  });

  it('delivers and records the configured benefit only for members who registered with LINE', async () => {
    const target = await fixture();
    const lineMember = await account();
    await db.user.update({ where: { id: lineMember.user.id }, data: { registrationMethod: 'LINE' } });
    const lineClient = new Client(); await lineClient.login(lineMember);
    expect((await new Client().call('admin/free-reports/benefit')).status).toBe(401);
    expect((await target.memberClient.call('admin/free-reports/benefit')).status).toBe(403);
    expect((await target.memberClient.call('admin/free-reports/benefit', 'PATCH', { revision: 0, title: '拒否', description: '拒否', videoUrl: 'https://video.example.test/rejected', reason: '拒否確認' })).status).toBe(403);
    const before = adminFreeMemberBenefitResponseSchema.parse((await target.adminClient.call('admin/free-reports/benefit')).body);
    const savedResponse = await target.adminClient.call('admin/free-reports/benefit', 'PATCH', { revision: before.revision, title: 'パドックで評価を変えた実例', description: '事前評価から結果検証までを解説します。', videoUrl: 'https://video.example.test/bonus', reason: 'LP登録特典の設定' });
    expect(savedResponse.status).toBe(200);
    const saved = adminFreeMemberBenefitResponseSchema.parse(savedResponse.body);
    expect(saved).toMatchObject({ revision: before.revision + 1, updatedBy: target.admin.user.id, updatedAt: expect.any(String), audience: { eligibleMembers: expect.any(Number), viewedMembers: expect.any(Number) } });
    expect(saved.audience.eligibleMembers).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(saved)).not.toMatch(/email|password|token|authSubject|lineSubject/i);
    expect((await new Client().call('me/free-benefit')).status).toBe(401);
    expect(publicFreeMemberBenefitResponseSchema.parse((await target.memberClient.call('me/free-benefit')).body)).toEqual({ configured: false });
    const deniedView = await target.memberClient.call('me/free-benefit/view', 'POST');
    expect(deniedView.status).toBe(404); expect(deniedView.body.code).toBe('FREE_BENEFIT_NOT_FOUND');
    const lineBenefit = publicFreeMemberBenefitResponseSchema.parse((await lineClient.call('me/free-benefit')).body);
    expect(lineBenefit).toMatchObject({ configured: true, title: 'パドックで評価を変えた実例', viewedAt: null });
    expect(JSON.stringify(lineBenefit)).not.toMatch(/videoUrl|revision|updatedBy|userId|email|password|token/i);
    const firstViewResponse = await lineClient.call('me/free-benefit/view', 'POST');
    expect(firstViewResponse.status).toBe(201); const firstView = publicFreeMemberBenefitViewResponseSchema.parse(firstViewResponse.body);
    expect(firstView).toMatchObject({ videoUrl: 'https://video.example.test/bonus', viewedAt: expect.any(String) });
    const repeatedView = publicFreeMemberBenefitViewResponseSchema.parse((await lineClient.call('me/free-benefit/view', 'POST')).body);
    expect(repeatedView.viewedAt).toBe(firstView.viewedAt);
    expect(await db.memberJourneyEvent.count({ where: { userId: lineMember.user.id, eventType: 'REGISTRATION_BENEFIT_VIEWED' } })).toBe(1);
    const viewedBenefit = publicFreeMemberBenefitResponseSchema.parse((await lineClient.call('me/free-benefit')).body);
    expect(viewedBenefit).toMatchObject({ configured: true, viewedAt: firstView.viewedAt });
    const after = adminFreeMemberBenefitResponseSchema.parse((await target.adminClient.call('admin/free-reports/benefit')).body);
    expect(after.audience.viewedMembers).toBeGreaterThanOrEqual(saved.audience.viewedMembers + 1);
  });

  it('adds, lists, edits and tracks multiple LINE registration benefits independently', async () => {
    const target = await fixture(); const suffix = randomUUID().slice(0, 8);
    const lineMember = await account(); await db.user.update({ where: { id: lineMember.user.id }, data: { registrationMethod: 'LINE' } });
    const lineClient = new Client(); await lineClient.login(lineMember);
    expect((await new Client().call('admin/free-reports/benefits')).status).toBe(401);
    expect((await target.memberClient.call('admin/free-reports/benefits')).status).toBe(403);
    expect((await target.memberClient.call('admin/free-reports/benefits', 'POST', { title: '拒否', description: '拒否', videoUrl: 'https://video.example.test/rejected', reason: '権限確認' })).status).toBe(403);
    const firstResponse = await target.adminClient.call('admin/free-reports/benefits', 'POST', { title: `登録特典A${suffix}`, description: '最初に追加する特典です。', videoUrl: `https://video.example.test/benefit-a-${suffix}`, reason: '複数特典の追加確認' });
    expect(firstResponse.status).toBe(201); createdBenefitIds.push(firstResponse.body.id);
    const secondResponse = await target.adminClient.call('admin/free-reports/benefits', 'POST', { title: `登録特典B${suffix}`, description: '次に追加する特典です。', videoUrl: `https://video.example.test/benefit-b-${suffix}`, reason: '複数特典の追加確認' });
    expect(secondResponse.status).toBe(201); createdBenefitIds.push(secondResponse.body.id);
    const adminList = adminFreeMemberBenefitListResponseSchema.parse((await target.adminClient.call('admin/free-reports/benefits')).body);
    const first = adminList.items.find(item => item.id === firstResponse.body.id); const second = adminList.items.find(item => item.id === secondResponse.body.id);
    expect(first).toMatchObject({ title: `登録特典A${suffix}`, revision: 1, viewedMembers: 0 });
    expect(second).toMatchObject({ title: `登録特典B${suffix}`, revision: 1, viewedMembers: 0 });
    expect(adminList.items.findIndex(item => item.id === secondResponse.body.id)).toBeLessThan(adminList.items.findIndex(item => item.id === firstResponse.body.id));
    expect(JSON.stringify(adminList)).not.toMatch(/email|password|token|authSubject|lineSubject/i);
    const editedResponse = await target.adminClient.call(`admin/free-reports/benefits/${firstResponse.body.id}`, 'PATCH', { revision: 1, title: `登録特典A改${suffix}`, description: '最初の特典だけを修正しました。', videoUrl: `https://video.example.test/benefit-a-edited-${suffix}`, reason: '特典単位の編集確認' });
    expect(editedResponse.status).toBe(200); expect(editedResponse.body).toMatchObject({ id: firstResponse.body.id, revision: 2, title: `登録特典A改${suffix}` });
    const staleEdit = await target.adminClient.call(`admin/free-reports/benefits/${firstResponse.body.id}`, 'PATCH', { revision: 1, title: '競合', description: '競合', videoUrl: 'https://video.example.test/conflict', reason: '競合確認' });
    expect(staleEdit.status).toBe(409); expect(staleEdit.body.code).toBe('FREE_BENEFIT_CONFLICT');
    expect((await new Client().call('me/free-benefits')).status).toBe(401);
    expect(publicFreeMemberBenefitListResponseSchema.parse((await target.memberClient.call('me/free-benefits')).body)).toEqual({ items: [] });
    const publicList = publicFreeMemberBenefitListResponseSchema.parse((await lineClient.call('me/free-benefits')).body);
    expect(publicList.items.find(item => item.id === firstResponse.body.id)).toMatchObject({ title: `登録特典A改${suffix}`, viewedAt: null });
    expect(publicList.items.find(item => item.id === secondResponse.body.id)).toMatchObject({ title: `登録特典B${suffix}`, viewedAt: null });
    expect(JSON.stringify(publicList)).not.toMatch(/videoUrl|revision|updatedBy|userId|email|password|token/i);
    const firstViewResponse = await lineClient.call(`me/free-benefits/${firstResponse.body.id}/view`, 'POST');
    expect(firstViewResponse.status).toBe(201); const firstView = publicFreeMemberBenefitViewResponseSchema.parse(firstViewResponse.body);
    expect(firstView).toMatchObject({ videoUrl: `https://video.example.test/benefit-a-edited-${suffix}`, viewedAt: expect.any(String) });
    const repeatedView = publicFreeMemberBenefitViewResponseSchema.parse((await lineClient.call(`me/free-benefits/${firstResponse.body.id}/view`, 'POST')).body);
    expect(repeatedView.viewedAt).toBe(firstView.viewedAt);
    const afterFirstView = publicFreeMemberBenefitListResponseSchema.parse((await lineClient.call('me/free-benefits')).body);
    expect(afterFirstView.items.find(item => item.id === firstResponse.body.id)?.viewedAt).toBe(firstView.viewedAt);
    expect(afterFirstView.items.find(item => item.id === secondResponse.body.id)?.viewedAt).toBeNull();
    expect(await db.freeMemberBenefitView.count({ where: { userId: lineMember.user.id, benefitId: firstResponse.body.id } })).toBe(1);
    expect(await db.freeMemberBenefitView.count({ where: { userId: lineMember.user.id, benefitId: secondResponse.body.id } })).toBe(0);
    const afterAdmin = adminFreeMemberBenefitListResponseSchema.parse((await target.adminClient.call('admin/free-reports/benefits')).body);
    expect(afterAdmin.items.find(item => item.id === firstResponse.body.id)?.viewedMembers).toBe(1);
    expect(afterAdmin.items.find(item => item.id === secondResponse.body.id)?.viewedMembers).toBe(0);
    expect(await db.auditLog.count({ where: { targetId: { in: [firstResponse.body.id, secondResponse.body.id] }, action: 'FREE_MEMBER_BENEFIT_CREATE', targetType: 'FREE_MEMBER_BENEFIT' } })).toBe(2);
    expect(await db.auditLog.count({ where: { targetId: firstResponse.body.id, action: 'FREE_MEMBER_BENEFIT_UPDATE', targetType: 'FREE_MEMBER_BENEFIT' } })).toBe(1);
  });

  it('publishes the post-race review only after a confirmed result', async () => {
    const target = await fixture();
    const base = { upEntryId: target.up.id, upReason: '前走より良化。', downEntryId: target.down.id, downReason: '落ち着きを欠く。', audioUrl: 'https://media.example.test/review-source.mp3' };
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 0, ...base, reviewText: '', reason: '発走前速報を準備' });
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 1, kind: 'PRE_RACE', reason: '発走前に公開' }, undefined, { 'Idempotency-Key': randomUUID() });
    await db.race.update({ where: { id: target.race.id }, data: { startsAt: new Date(Date.now() - 60_000), status: 'FINISHED' } });
    const rejected = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 1, kind: 'POST_RACE_REVIEW', reason: '結果前の拒否確認' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(rejected.status).toBe(409); expect(rejected.body.code).toBe('FREE_REPORT_REVIEW_NOT_READY');
    await db.raceResultVersion.create({ data: { raceId: target.race.id, version: 1, sourceRevision: 1, ruleVersion: 'TEST_V1', entriesSnapshot: [], payoutsSnapshot: [], reason: '無料速報検証用の確定結果', confirmedBy: target.admin.user.id } });
    const saved = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 1, ...base, reviewText: '評価UP馬は2着。状態評価どおり力を出しました。', reason: '確定結果を検証' });
    expect(saved.body.revision).toBe(2);
    const beforePreview = await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })]);
    const preview = await target.adminClient.call(`admin/notifications/previews/free-report?raceId=${target.race.id}&kind=POST_RACE_REVIEW&revision=2`);
    expect(preview.status).toBe(200); const parsedPreview = freeReportNotificationPreviewResponseSchema.parse(preview.body); expect(parsedPreview).toMatchObject({ eventType: 'FREE_REPORT_REVIEW_PUBLISHED', contentLabel: 'レース後検証', kind: 'POST_RACE_REVIEW', timing: 'IMMEDIATE', version: 2 });
    expect(parsedPreview.message.text).toContain('無料速報のレース後検証を公開しました');
    expect(await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })])).toEqual(beforePreview);
    const published = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 2, kind: 'POST_RACE_REVIEW', reason: '結果確認後に公開' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(published.status).toBe(201); expect(published.body.kind).toBe('POST_RACE_REVIEW');
    const view = await target.memberClient.call(`races/${target.race.id}/free-report`);
    expect(view.body.versions[0]).toMatchObject({ kind: 'POST_RACE_REVIEW', version: 2 });
    expect(view.body.versions[0].reviewText).toBeUndefined();
  });
});
