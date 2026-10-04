import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defaultContentAccessPolicy, parseContentAccessPolicy, publicWin5DetailResponseSchema, publicWin5ListResponseSchema } from '../packages/domain/src';
import { assessmentFixture } from './assessment-fixtures';
import { Client, db } from './helpers';

afterAll(() => db.$disconnect());

async function unusedTargetDate() {
  let day = Math.floor(Date.UTC(2600, 0, 1) / 86400000) + (parseInt(randomUUID().slice(0, 8), 16) % 20000);
  while (true) {
    const targetDate = new Date(day * 86400000).toISOString().slice(0, 10);
    const exists = await db.predictionProduct.findUnique({ where: { type_targetDate: { type: 'WIN5_PREVIEW', targetDate } }, select: { id: true } });
    if (!exists) return targetDate;
    day += 1;
  }
}

async function readyProduct(expertId: string, secret = '非公開のWIN5全体総評') {
  const targetDate = await unusedTargetDate();
  const product = await db.predictionProduct.create({
    data: {
      targetDate,
      title: `WIN5境界試験-${randomUUID().slice(0, 6)}`,
      expertId,
      scheduledPublishAt: new Date(`${targetDate}T00:00:00Z`),
      confidence: 'A',
      summary: secret,
      updatedBy: expertId
    }
  });
  const legs = [];
  for (let legNumber = 1; legNumber <= 5; legNumber++) {
    const horseName = `非公開の評価馬${legNumber}`;
    const race = await db.race.create({ data: { raceDate: targetDate, venue: `境界${legNumber}`, number: legNumber, name: `WIN5境界レース${legNumber}`, startsAt: new Date(`${targetDate}T${String(legNumber + 5).padStart(2, '0')}:00:00Z`) } });
    const entry = await db.raceEntry.create({ data: { race: { connect: { id: race.id } }, horse: { create: { id: randomUUID(), name: horseName } }, number: 1, gate: 1, horseName, sex: 'MALE', age: 3, carriedWeight: 57, jockey: '境界試験騎手', trainer: '境界試験調教師' } });
    const leg = await db.predictionProductRace.create({
      data: {
        productId: product.id,
        raceId: race.id,
        legNumber,
        confidence: 'A',
        paceView: `非公開の展開見解${legNumber}`,
        shortComment: `非公開の短評${legNumber}`,
        selections: { create: { entryId: entry.id, evaluationType: 'PRIMARY', reason: `非公開の選定理由${legNumber}`, displayOrder: 1 } }
      }
    });
    legs.push({ race, entry, leg });
  }
  return { product, legs, targetDate, secret };
}

describe('WIN5 security boundaries', () => {
  it('rejects anonymous users, members, AAL1 staff and unassigned experts with the correct boundary', async () => {
    const assigned = await assessmentFixture('EXPERT', 2);
    const outsider = await assessmentFixture('EXPERT', 2);
    const lowAdmin = await assessmentFixture('ADMIN', 1);
    const member = await assessmentFixture('MEMBER', 1);
    const target = await readyProduct(assigned.owner.user.id);
    const detailPath = `expert/win5/${target.product.id}`;

    expect((await new Client().call(`admin/win5/${target.product.id}`)).status).toBe(401);
    expect(await member.client.call(`admin/win5/${target.product.id}`)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await lowAdmin.client.call(`admin/win5/${target.product.id}`)).toMatchObject({ status: 403, body: { code: 'MFA_REQUIRED' } });
    expect(await outsider.client.call(detailPath)).toMatchObject({ status: 403, body: { code: 'WIN5_ACCESS_DENIED' } });
    expect(await outsider.client.call(`${detailPath}/options`)).toMatchObject({ status: 403, body: { code: 'WIN5_ACCESS_DENIED' } });
    expect(await outsider.client.call(`${detailPath}/preview`, 'POST', { productRevision: target.product.revision, correctionReason: '' })).toMatchObject({ status: 403, body: { code: 'WIN5_ACCESS_DENIED' } });
    const first = target.legs[0];
    const memberMutation = await member.client.call(`expert/win5/${target.product.id}/races/1`, 'PUT', {
      productRevision: target.product.revision,
      raceId: first.race.id,
      confidence: 'A',
      paceView: '権限を偽装した展開見解',
      shortComment: '権限を偽装した短評',
      evaluations: [{ entryId: first.entry.id, evaluationType: 'PRIMARY', reason: '権限を偽装した理由', displayOrder: 1 }],
      reason: 'roleを送っても権限を得られないことを確認',
      role: 'ADMIN'
    });
    expect(memberMutation.status).toBe(400);
    expect(await member.client.call(`expert/win5/${target.product.id}/races/1`, 'PUT', {
      productRevision: target.product.revision,
      raceId: first.race.id,
      confidence: 'A',
      paceView: '会員による展開見解',
      shortComment: '会員による短評',
      evaluations: [{ entryId: first.entry.id, evaluationType: 'PRIMARY', reason: '会員による理由', displayOrder: 1 }],
      reason: '会員操作を拒否する境界確認'
    })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect((await assigned.client.call(detailPath)).status).toBe(200);
  });

  it('binds publication previews to the product, actor, current draft and expiry', async () => {
    const firstAdmin = await assessmentFixture('ADMIN', 2);
    const secondAdmin = await assessmentFixture('ADMIN', 2);
    const first = await readyProduct(firstAdmin.owner.user.id);
    const second = await readyProduct(firstAdmin.owner.user.id);
    const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { predictionPublicationEnabled: true } });
    await db.systemSetting.update({ where: { id: 'global' }, data: { predictionPublicationEnabled: true } });
    try {
      const checked = await firstAdmin.client.call(`admin/win5/${first.product.id}/preview`, 'POST', { productRevision: first.product.revision, correctionReason: '' });
      expect(checked.status).toBe(201);
      expect((await secondAdmin.client.call(`admin/win5/${first.product.id}/publish/${checked.body.previewId}`, 'POST')).status).toBe(404);
      expect((await firstAdmin.client.call(`admin/win5/${second.product.id}/publish/${checked.body.previewId}`, 'POST')).status).toBe(404);
      await db.predictionProduct.update({ where: { id: first.product.id }, data: { summary: '確認後に変更した総評', revision: { increment: 1 } } });
      expect(await firstAdmin.client.call(`admin/win5/${first.product.id}/publish/${checked.body.previewId}`, 'POST')).toMatchObject({ status: 409, body: { code: 'WIN5_STALE_PREVIEW' } });

      const current = await db.predictionProduct.findUniqueOrThrow({ where: { id: first.product.id }, select: { revision: true } });
      const expiring = await firstAdmin.client.call(`admin/win5/${first.product.id}/preview`, 'POST', { productRevision: current.revision, correctionReason: '' });
      expect(expiring.status).toBe(201);
      await db.predictionProductPreview.update({ where: { id: expiring.body.previewId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await firstAdmin.client.call(`admin/win5/${first.product.id}/publish/${expiring.body.previewId}`, 'POST')).toMatchObject({ status: 409, body: { code: 'PREVIEW_EXPIRED' } });
      expect(await db.predictionProductVersion.count({ where: { productId: { in: [first.product.id, second.product.id] } } })).toBe(0);
    } finally {
      await db.systemSetting.update({ where: { id: 'global' }, data: settings });
    }
  });

  it('keeps horse evaluations and commentary hidden without a current allowed entitlement', async () => {
    const publisher = await assessmentFixture('ADMIN', 2);
    const freeMember = await assessmentFixture('MEMBER', 1);
    const expiredMember = await assessmentFixture('MEMBER', 1);
    const paidMember = await assessmentFixture('MEMBER', 1);
    const target = await readyProduct(publisher.owner.user.id);
    const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { predictionPublicationEnabled: true, contentAccessPolicy: true } });
    await db.systemSetting.update({ where: { id: 'global' }, data: { predictionPublicationEnabled: true, contentAccessPolicy: defaultContentAccessPolicy } });
    try {
      const checked = await publisher.client.call(`admin/win5/${target.product.id}/preview`, 'POST', { productRevision: target.product.revision, correctionReason: '' });
      const published = await publisher.client.call(`admin/win5/${target.product.id}/publish/${checked.body.previewId}`, 'POST');
      expect(published.status).toBe(201);
      const now = new Date();
      await db.entitlement.create({ data: { userId: expiredMember.owner.user.id, planCode: 'STANDARD', startsAt: new Date(now.getTime() - 7200000), endsAt: new Date(now.getTime() - 3600000), reason: '期限切れ境界試験', grantedBy: publisher.owner.user.id } });
      await db.entitlement.create({ data: { userId: paidMember.owner.user.id, planCode: 'STANDARD', startsAt: new Date(now.getTime() - 1000), endsAt: new Date(now.getTime() + 3600000), reason: '有効権限境界試験', grantedBy: publisher.owner.user.id } });

      const anonymous = await new Client().call(`win5/${target.product.id}?version=1`);
      const free = await freeMember.client.call(`win5/${target.product.id}?version=1`);
      const expired = await expiredMember.client.call(`win5/${target.product.id}`);
      for (const response of [anonymous, free, expired]) {
        expect(response.status).toBe(200);
        expect(publicWin5DetailResponseSchema.parse(response.body).access).toBe('METADATA');
        expect(JSON.stringify(response.body)).not.toMatch(/非公開のWIN5全体総評|非公開の評価馬|非公開の展開見解|非公開の短評|非公開の選定理由|contentSnapshot|evaluations|horseName|summary/);
      }
      const list = await new Client().call(`win5?targetDate=${target.targetDate}`);
      expect(publicWin5ListResponseSchema.parse(list.body).total).toBe(1);
      expect(JSON.stringify(list.body)).not.toMatch(/非公開のWIN5全体総評|非公開の評価馬|contentSnapshot|evaluations|horseName|summary/);

      const policy = parseContentAccessPolicy(settings.contentAccessPolicy);
      await db.systemSetting.update({ where: { id: 'global' }, data: { contentAccessPolicy: { ...policy, monthly: { ...policy.monthly, win5: false } } } });
      expect(publicWin5DetailResponseSchema.parse((await paidMember.client.call(`win5/${target.product.id}`)).body).access).toBe('METADATA');
      await db.systemSetting.update({ where: { id: 'global' }, data: { contentAccessPolicy: defaultContentAccessPolicy } });
      const allowed = await paidMember.client.call(`win5/${target.product.id}`);
      expect(publicWin5DetailResponseSchema.parse(allowed.body).access).toBe('FULL');
      expect(JSON.stringify(allowed.body)).toMatch(/非公開のWIN5全体総評/);
      expect(JSON.stringify(allowed.body)).toMatch(/非公開の評価馬1/);
    } finally {
      await db.systemSetting.update({ where: { id: 'global' }, data: settings });
    }
  });
});
