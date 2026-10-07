import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { blankAssessment, expertAssessmentHistoryResponseSchema, expertAssessmentSaveResponseSchema, expertAssessmentWorkspaceResponseSchema, paddockComplete } from '../packages/domain/src';
import { assessmentFixture } from './assessment-fixtures';
import { db } from './helpers';
let fixture: Awaited<ReturnType<typeof assessmentFixture>>;
beforeAll(async () => { fixture = await assessmentFixture(); });
afterAll(() => db.$disconnect());
const input = () => ({ content: { ...blankAssessment, preScore: 80, preRank: 1, preMark: 'HONMEI', body: 0 }, revision: 0, raceRevision: 1, horseId: fixture.entries[0].horseId, mutationId: randomUUID(), reason: '評価結合試験' });
const path = () => `expert/races/${fixture.race.id}/entries/${fixture.entries[0].id}/assessment`;
describe('assessment drafts with server-owned access and append-only history', () => {
  it('requires assignment and AAL2 for reads and writes, regardless of submitted role', async () => {
    const other = await assessmentFixture(); const member = await assessmentFixture('MEMBER'); const low = await assessmentFixture('EXPERT', 1);
    for (const c of [other.client, member.client, low.client]) {
      expect((await c.call(`expert/races/${fixture.race.id}/assessments`)).status).toBe(403);
      expect((await c.call(`expert/races/${fixture.race.id}/entries/${fixture.entries[0].id}/history`)).status).toBe(403);
      expect((await c.call(path(), 'POST', input())).status).toBe(403);
    }
    expect((await low.client.call(`expert/races/${low.race.id}/assessments`)).status).toBe(403);
    expect((await fixture.client.call(path(), 'POST', { ...input(), role: 'ADMIN' })).status).toBe(400);
  });
  it('allows a race operator with AAL2 to assess an unassigned race', async () => {
    const target = await assessmentFixture(); const operator = await assessmentFixture('OPERATOR'); const low = await assessmentFixture('OPERATOR', 1);
    const readPath = `expert/races/${target.race.id}/assessments`;
    const savePath = `expert/races/${target.race.id}/entries/${target.entries[0].id}/assessment`;
    expect((await low.client.call(readPath)).status).toBe(403);
    expect((await operator.client.call(readPath)).status).toBe(200);
    const saved = await operator.client.call(savePath, 'POST', {
      content: { ...blankAssessment, preScore: 82, preRank: 1, preMark: 'HONMEI' }, revision: 0,
      raceRevision: target.race.revision, horseId: target.entries[0].horseId, mutationId: randomUUID(), reason: 'レース担当の評価権限確認'
    });
    expect(saved.status).toBe(201);
    const assessment = await db.assessment.findUniqueOrThrow({ where: { entryId: target.entries[0].id } });
    expect(await db.auditLog.count({ where: { actorId: operator.owner.user.id, targetId: assessment.id, action: 'ASSESSMENT_SAVE' } })).toBe(1);
  });
  it('returns the shared workspace contract without unused database fields', async () => {
    const result = await fixture.client.call(`expert/races/${fixture.race.id}/assessments`);
    expect(result.status).toBe(200);
    expect(expertAssessmentWorkspaceResponseSchema.parse(result.body)).toEqual(result.body);
    expect(Object.keys(result.body.entries[0]).sort()).toEqual(['assessment', 'horseId', 'horseName', 'id', 'number', 'status']);
    expect(JSON.stringify(result.body)).not.toMatch(/updatedBy|entrySnapshot|actorId|passwordHash|authSubject|token|secret/i);
  });
  it('normalizes historical combined condition data without rewriting the stored snapshot', async () => {
    const legacy = await assessmentFixture();
    const legacyContent = { preScore: null, preRank: null, preMark: null, preComment: '', body: 3, walk: 3, coat: 3, focus: 3, calm: 4, change: 'SAME', paddockComment: '旧形式' };
    await db.assessment.create({ data: { entryId: legacy.entries[0].id, revision: 1, updatedBy: legacy.owner.user.id, content: legacyContent } });
    const response = await legacy.client.call(`expert/races/${legacy.race.id}/assessments`);
    expect(response.status).toBe(200);
    const parsed = expertAssessmentWorkspaceResponseSchema.parse(response.body);
    expect(parsed.entries[0].assessment?.content).toMatchObject({ calm: 4, sweating: null, calmness: null });
    expect(paddockComplete(parsed.entries[0].assessment!.content)).toBe(true);
    expect((await db.assessment.findUniqueOrThrow({ where: { entryId: legacy.entries[0].id } })).content).toEqual(legacyContent);
  });
  it('rejects creating or changing the legacy combined condition through the API', async () => {
    const target = await assessmentFixture();
    const savePath = `expert/races/${target.race.id}/entries/${target.entries[0].id}/assessment`;
    const result = await target.client.call(savePath, 'POST', {
      content: { ...blankAssessment, calm: 4 }, revision: 0, raceRevision: target.race.revision,
      horseId: target.entries[0].horseId, mutationId: randomUUID(), reason: '旧形式の新規保存を拒否'
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('LEGACY_ASSESSMENT_READ_ONLY');
    expect(await db.assessment.findUnique({ where: { entryId: target.entries[0].id } })).toBeNull();
  });
  it('saves partial inputs, retries once and rejects concurrent stale writes', async () => {
    const first = input(); const result = await fixture.client.call(path(), 'POST', first); expect(result.status).toBe(201);
    expect(expertAssessmentSaveResponseSchema.parse(result.body)).toEqual(result.body);
    expect(Object.keys(result.body).sort()).toEqual(['content', 'revision']);
    const fullSavedRow = await db.assessment.findUniqueOrThrow({ where: { entryId: fixture.entries[0].id } });
    const legacyContent = Object.fromEntries(Object.entries(first.content).filter(([key]) => key !== 'sweating' && key !== 'calmness'));
    const legacyRequestHash = createHash('sha256').update(JSON.stringify({ ...first, content: legacyContent })).digest('hex');
    await db.idempotencyKey.update({ where: { key: `assessment:${fixture.owner.user.id}:${fixture.entries[0].id}:${first.mutationId}` }, data: { requestHash: legacyRequestHash, response: JSON.parse(JSON.stringify(fullSavedRow)) } });
    const replay = await fixture.client.call(path(), 'POST', first);
    expect(replay.body.revision).toBe(1);
    expect(Object.keys(replay.body).sort()).toEqual(['content', 'revision']);
    expect((await fixture.client.call(path(), 'POST', { ...first, content: blankAssessment })).status).toBe(409);
    const outcomes = await Promise.all([fixture.client.call(path(), 'POST', { ...input(), revision: 1, content: { ...blankAssessment, body: 4 } }), fixture.client.call(path(), 'POST', { ...input(), revision: 1, content: { ...blankAssessment, body: 5 } })]);
    expect(outcomes.map(r => r.status).sort()).toEqual([201, 409]);
    const saved = await db.assessment.findUniqueOrThrow({ where: { entryId: fixture.entries[0].id }, include: { versions: true } });
    expect(saved.revision).toBe(2); expect(saved.versions).toHaveLength(2);
    expect(await db.auditLog.count({ where: { targetId: saved.id, action: 'ASSESSMENT_SAVE' } })).toBe(2);
    await expect(db.assessmentVersion.update({ where: { id: saved.versions[0].id }, data: { reason: 'rewrite' } })).rejects.toThrow();
    await expect(db.assessmentVersion.delete({ where: { id: saved.versions[0].id } })).rejects.toThrow();
    await expect(db.$executeRawUnsafe('TRUNCATE assessment_versions')).rejects.toThrow();
  });
  it('rejects race changes and reassignment before synchronization; history remains readable by authorized admin', async () => {
    await db.race.update({ where: { id: fixture.race.id }, data: { revision: { increment: 1 } } });
    expect((await fixture.client.call(path(), 'POST', { ...input(), revision: 2 })).body.code).toBe('RACE_CHANGED');
    await db.expertAssignment.delete({ where: { raceId_userId: { raceId: fixture.race.id, userId: fixture.owner.user.id } } });
    expect((await fixture.client.call(path(), 'POST', { ...input(), revision: 2, raceRevision: 2 })).status).toBe(403);
    const admin = await assessmentFixture('ADMIN');
    const history = await admin.client.call(`expert/races/${fixture.race.id}/entries/${fixture.entries[0].id}/history`);
    expect(history.status).toBe(200); expect(history.body.total).toBe(2);
    expect(expertAssessmentHistoryResponseSchema.parse(history.body)).toEqual(history.body);
    expect(Object.keys(history.body.items[0]).sort()).toEqual(['content', 'createdAt', 'reason', 'revision']);
    expect(JSON.stringify(history.body)).not.toMatch(/entrySnapshot|actorId|assessmentId|passwordHash|authSubject|token|secret/i);
    expect((await admin.client.call(path(), 'POST', { ...input(), revision: 2, raceRevision: 2 })).status).toBe(201);
  });
});
