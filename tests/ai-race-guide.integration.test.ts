import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { aiRaceGuideAdminResponseSchema, aiRaceGuideDataCoverageResponseSchema, aiRaceGuidePublicResponseSchema } from '../packages/domain/src';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

async function fixture() {
  const seed = Number.parseInt(randomUUID().slice(0, 8), 16);
  const year = 2060 + seed % 30, month = 1 + Math.floor(seed / 30) % 12, day = 1 + Math.floor(seed / 360) % 28;
  const raceDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const race = await db.race.create({ data: {
    raceDate, venue: ['札幌', '東京', '中山', '京都', '阪神'][seed % 5], number: 1 + Math.floor(seed / 10080) % 12,
    name: `AIガイド結合試験 ${randomUUID().slice(0, 6)}`, raceClass: 'synthetic', distance: 1600, surface: 'TURF', direction: 'RIGHT', going: 'GOOD', weather: '晴',
    startsAt: new Date(`${raceDate}T15:00:00+09:00`),
    entries: { create: [1, 2].map(number => ({ horse: { create: { id: randomUUID(), name: `合成馬${number}` } }, number, gate: number, horseName: `合成馬${number}`, sex: 'MALE', age: 4, carriedWeight: 57, jockey: `騎手${number}`, trainer: `調教師${number}` })) }
  }, include: { entries: true } });
  const adminAccount = await account('ADMIN'); const admin = new Client(); await admin.login(adminAccount); await admin.mfa();
  const memberAccount = await account('MEMBER'); const member = new Client(); await member.login(memberAccount);
  return { race, admin, adminAccount, member, memberAccount };
}

describe('AI race guide synthetic generation and publication', () => {
  it('generates, validates, approves and publishes without exposing paid content to free members', async () => {
    const target = await fixture(); const endpoint = `admin/races/${target.race.id}/ai-guide`;
    const denied = await target.member.call(`${endpoint}/generations`, 'POST', { revision: 0, mutationId: randomUUID(), reason: '権限境界' });
    expect(denied.status).toBe(403);
    const generated = await target.admin.call(`${endpoint}/generations`, 'POST', { revision: 0, mutationId: randomUUID(), reason: 'synthetic fixture結合試験' });
    expect(generated.status).toBe(201);
    const generatedBody = aiRaceGuideAdminResponseSchema.parse(generated.body);
    expect(generatedBody).toMatchObject({ runtime: { transport: 'test' }, guide: { status: 'REVIEW_REQUIRED' }, generations: [{ validationStatus: 'VALID', modelProvider: 'test' }] });
    expect(JSON.stringify(generatedBody.generations[0].structuredInputSnapshot)).not.toMatch(/assessment|prediction|三国谷/iu);
    const generationId = generatedBody.guide!.latestGenerationId!;
    const approved = await target.admin.call(`${endpoint}/approve`, 'POST', { revision: generatedBody.guide!.revision, generationId, mutationId: randomUUID(), reason: 'FactとEvidenceを確認' });
    expect(approved.status).toBe(201);
    const approvedBody = aiRaceGuideAdminResponseSchema.parse(approved.body);
    expect(approvedBody.guide?.status).toBe('READY');
    const mutationId = randomUUID(); const publication = { revision: approvedBody.guide!.revision, generationId, mutationId, reason: '公開前確認済み', correctionReason: '' };
    const published = await target.admin.call(`${endpoint}/publish`, 'POST', publication);
    expect(published.status).toBe(201);
    const publishedBody = aiRaceGuideAdminResponseSchema.parse(published.body);
    expect(publishedBody).toMatchObject({ guide: { status: 'PUBLISHED' }, versions: [{ version: 1 }] });
    expect((await target.admin.call(`${endpoint}/publish`, 'POST', publication)).body).toEqual(published.body);

    const free = await target.member.call(`races/${target.race.id}/ai-guide`);
    expect(free.status).toBe(200);
    const freeBody = aiRaceGuidePublicResponseSchema.parse(free.body);
    expect(freeBody).toMatchObject({ available: true, accessScope: 'FREE_PREVIEW' });
    if (!freeBody.available) throw new Error('guide unavailable');
    expect(freeBody.content.sections).toHaveLength(1);

    await db.entitlement.create({ data: { userId: target.memberAccount.user.id, planCode: 'STANDARD', startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 86_400_000), raceDate: null, reason: 'AIガイド有料表示試験', grantedBy: target.adminAccount.user.id } });
    const paid = aiRaceGuidePublicResponseSchema.parse((await target.member.call(`races/${target.race.id}/ai-guide`)).body);
    expect(paid).toMatchObject({ available: true, accessScope: 'PAID_FULL' });
    if (!paid.available) throw new Error('guide unavailable');
    expect(paid.content.sections.length).toBeGreaterThan(1);
    const version = await db.aiRaceGuideVersion.findFirstOrThrow({ where: { guide: { raceId: target.race.id } } });
    const generation = await db.aiRaceGuideGeneration.findUniqueOrThrow({ where: { id: generationId } });
    expect(await db.auditLog.count({ where: { targetId: { in: [generation.id, version.id] }, action: { in: ['AI_GUIDE_GENERATION_REQUEST', 'AI_GUIDE_APPROVE', 'AI_GUIDE_PUBLISH'] } } })).toBe(3);
    await expect(db.aiRaceGuideVersion.update({ where: { id: version.id }, data: { correctionReason: 'rewrite' } })).rejects.toThrow();
    await expect(db.aiRaceGuideVersion.delete({ where: { id: version.id } })).rejects.toThrow();
    await expect(db.aiRaceGuideGeneration.update({ where: { id: generation.id }, data: { failureCode: 'rewrite' } })).rejects.toThrow();
    await expect(db.aiRaceGuideGeneration.delete({ where: { id: generation.id } })).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE ai_race_guide_versions')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE ai_race_guide_generations')).rejects.toThrow();
  });

  it('blocks stale and invalid generations from approval', async () => {
    const target = await fixture(); const endpoint = `admin/races/${target.race.id}/ai-guide`;
    const generated = aiRaceGuideAdminResponseSchema.parse((await target.admin.call(`${endpoint}/generations`, 'POST', { revision: 0, mutationId: randomUUID(), reason: 'stale検証' })).body);
    await db.race.update({ where: { id: target.race.id }, data: { revision: { increment: 1 }, weather: '曇' } });
    const stale = await target.admin.call(`${endpoint}/approve`, 'POST', { revision: generated.guide!.revision, generationId: generated.guide!.latestGenerationId, mutationId: randomUUID(), reason: '変更後の承認' });
    expect(stale).toMatchObject({ status: 409, body: { code: 'AI_GUIDE_STALE' } });
    const guide = await db.aiRaceGuide.findUniqueOrThrow({ where: { raceId: target.race.id } });
    const latest = await db.aiRaceGuideGeneration.findFirstOrThrow({ where: { guideId: guide.id }, orderBy: { attemptNo: 'desc' } });
    const invalid = await db.aiRaceGuideGeneration.create({ data: { guideId: guide.id, attemptNo: latest.attemptNo + 1, structuredInputSnapshot: latest.structuredInputSnapshot, inputHash: latest.inputHash, dataCutoffAt: latest.dataCutoffAt, logicVersion: latest.logicVersion, promptVersion: latest.promptVersion, sourceVersion: latest.sourceVersion, modelProvider: 'test', modelVersion: latest.modelVersion, generatedOutput: latest.generatedOutput!, validationStatus: 'INVALID', validationErrors: ['forced invalid fixture'] } });
    const changed = await db.aiRaceGuide.update({ where: { id: guide.id }, data: { latestGenerationId: invalid.id, status: 'REVIEW_REQUIRED', revision: { increment: 1 } } });
    const refused = await target.admin.call(`${endpoint}/approve`, 'POST', { revision: changed.revision, generationId: invalid.id, mutationId: randomUUID(), reason: 'invalid検証' });
    expect(refused).toMatchObject({ status: 400, body: { code: 'AI_GUIDE_VALIDATION_FAILED' } });
    expect(await db.aiRaceGuideVersion.count({ where: { guideId: guide.id } })).toBe(0);
  });

  it('stores identity/provenance extensions safely and reports cutoff-bound coverage', async () => {
    const target = await fixture();
    const provider = `SYNTHETIC_${randomUUID()}`;
    for (const sourceKind of ['RACE', 'RACE_ENTRY', 'RACE_RESULT']) {
      await db.dataLicensePolicy.create({ data: {
        provider, sourceKind, fieldName: '*', policyVersion: 'integration-v1', storageUse: 'APPROVED', derivationUse: 'APPROVED', memberDisplayUse: 'APPROVED', externalAiUse: 'PROHIBITED', effectiveFrom: new Date(Date.now() - 60_000), decisionReference: 'synthetic integration fixture'
      } });
    }
    const identity = await db.horseExternalIdentity.create({ data: {
      horseId: target.race.entries[0].horseId, provider, externalKeyHash: 'a'.repeat(64), sourceVersion: 'fixture-v1', observedName: target.race.entries[0].horseName, matchStatus: 'MATCHED', firstObservedAt: new Date(Date.now() - 60_000), lastObservedAt: new Date()
    } });
    await expect(db.horseExternalIdentity.create({ data: { horseId: null, provider, externalKeyHash: identity.externalKeyHash, sourceVersion: 'fixture-v1', observedName: identity.observedName, matchStatus: 'UNRESOLVED', firstObservedAt: new Date(), lastObservedAt: new Date() } })).rejects.toThrow();
    await expect(db.horseExternalIdentity.update({ where: { id: identity.id }, data: { externalKeyHash: 'b'.repeat(64) } })).rejects.toThrow();

    const pastDate = `${Number(target.race.raceDate.slice(0, 4)) - 1}${target.race.raceDate.slice(4)}`;
    const past = await db.race.create({ data: {
      raceDate: pastDate, venue: target.race.venue, number: target.race.number, name: `過去走 ${randomUUID().slice(0, 6)}`, startsAt: new Date(`${pastDate}T15:00:00+09:00`), raceClass: 'synthetic', distance: 1600, surface: 'TURF', direction: 'RIGHT', going: 'GOOD', status: 'FINISHED',
      entries: { create: target.race.entries.map(entry => ({ horse: { connect: { id: entry.horseId } }, number: entry.number, gate: entry.gate, horseName: entry.horseName, sex: entry.sex, age: entry.age, carriedWeight: entry.carriedWeight, jockey: entry.jockey, trainer: entry.trainer })) }
    }, include: { entries: true } });
    const entriesSnapshot = past.entries.map((entry, index) => ({ entryId: entry.id, status: 'FINISHED', finishPosition: index + 1, popularity: index + 1, finalOdds: `${index + 2}.0` }));
    const version1 = await db.raceResultVersion.create({ data: { raceId: past.id, version: 1, sourceRevision: 1, ruleVersion: 'result-v1', raceCanceled: false, entriesSnapshot, payoutsSnapshot: [], reason: 'synthetic first result', confirmedBy: target.adminAccount.user.id, confirmedAt: new Date(Date.now() - 120_000) } });
    await db.raceResultVersion.create({ data: { raceId: past.id, version: 2, sourceRevision: 2, ruleVersion: 'result-v1', raceCanceled: false, entriesSnapshot: entriesSnapshot.map((entry, index) => ({ ...entry, finishPosition: index ? 1 : 2 })), payoutsSnapshot: [], reason: 'synthetic correction', confirmedBy: target.adminAccount.user.id, confirmedAt: new Date(Date.now() - 60_000) } });
    await db.raceResultVersion.create({ data: { raceId: past.id, version: 3, sourceRevision: 3, ruleVersion: 'result-v1', raceCanceled: false, entriesSnapshot, payoutsSnapshot: [], reason: 'future correction must not leak', confirmedBy: target.adminAccount.user.id, confirmedAt: new Date(Date.now() + 86_400_000) } });
    const policy = await db.dataLicensePolicy.findFirstOrThrow({ where: { provider, sourceKind: 'RACE_RESULT' } });
    const performance = await db.raceEntryPerformance.create({ data: { resultVersionId: version1.id, raceEntryId: past.entries[0].id, finishTimeMs: 95432, finalSectionTimeMs: 34100, bodyWeightKg: 480, bodyWeightChangeKg: 4, cornerPositions: [3, 3, 2, 2], sourceProvider: provider, sourceVersion: 'fixture-v1', sourceRecordReference: 'synthetic-performance-1', observedAt: new Date(Date.now() - 120_000), importedAt: new Date(Date.now() - 60_000), licensePolicyId: policy.id } });
    await expect(db.raceEntryPerformance.update({ where: { id: performance.id }, data: { bodyWeightKg: 481 } })).rejects.toThrow();
    await expect(db.raceEntryPerformance.delete({ where: { id: performance.id } })).rejects.toThrow();
    await expect(db.dataLicensePolicy.update({ where: { id: policy.id }, data: { decisionReference: 'rewrite' } })).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE race_entry_performances')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE data_license_policies')).rejects.toThrow();

    expect((await target.member.call(`admin/races/${target.race.id}/ai-guide/data-coverage`)).status).toBe(403);
    const response = await target.admin.call(`admin/races/${target.race.id}/ai-guide/data-coverage`);
    expect(response.status).toBe(200);
    const coverage = aiRaceGuideDataCoverageResponseSchema.parse(response.body);
    expect(coverage.boundaries).toEqual({ assessmentExcluded: true, predictionExcluded: true, expertCommentExcluded: true, userDataExcluded: true, futureDataExcluded: true, externalAiCommunication: false });
    expect(coverage.coverage.find(item => item.category === 'PAST_RACES')).toMatchObject({ status: 'PARTIAL', availableCount: 0, requiredCount: 2 });
    expect(coverage.factStates).toMatchObject({ insufficientData: 2 });
  });
});
