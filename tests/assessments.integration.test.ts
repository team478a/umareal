import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { blankAssessment, expertAssessmentHistoryResponseSchema, expertAssessmentSaveResponseSchema, expertAssessmentWorkspaceResponseSchema } from '../packages/domain/src';
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
  it('returns the shared workspace contract without unused database fields', async () => {
    const result = await fixture.client.call(`expert/races/${fixture.race.id}/assessments`);
    expect(result.status).toBe(200);
    expect(expertAssessmentWorkspaceResponseSchema.parse(result.body)).toEqual(result.body);
    expect(Object.keys(result.body.entries[0]).sort()).toEqual(['assessment', 'horseId', 'horseName', 'id', 'number', 'status']);
    expect(JSON.stringify(result.body)).not.toMatch(/updatedBy|entrySnapshot|actorId|passwordHash|authSubject|token|secret/i);
  });
  it('saves partial inputs, retries once and rejects concurrent stale writes', async () => {
    const first = input(); const result = await fixture.client.call(path(), 'POST', first); expect(result.status).toBe(201);
    expect(expertAssessmentSaveResponseSchema.parse(result.body)).toEqual(result.body);
    expect(Object.keys(result.body).sort()).toEqual(['content', 'revision']);
    const fullSavedRow = await db.assessment.findUniqueOrThrow({ where: { entryId: fixture.entries[0].id } });
    await db.idempotencyKey.update({ where: { key: `assessment:${fixture.owner.user.id}:${fixture.entries[0].id}:${first.mutationId}` }, data: { response: JSON.parse(JSON.stringify(fullSavedRow)) } });
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
