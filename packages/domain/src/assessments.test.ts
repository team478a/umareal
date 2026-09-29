import { describe, expect, it } from 'vitest';
import { assessmentSchema, blankAssessment, expertAssessmentHistoryResponseSchema, expertAssessmentSaveResponseSchema, expertAssessmentWorkspaceResponseSchema, paddockComplete, preComplete } from './assessments';
describe('partial assessments and explicit unknown values', () => {
  it('accepts partial drafts but does not count missing fields as complete', () => {
    expect(assessmentSchema.safeParse(blankAssessment).success).toBe(true);
    expect(paddockComplete(blankAssessment)).toBe(false);
    expect(preComplete(blankAssessment)).toBe(false);
  });
  it('counts unable-to-assess as entered and zero pre-score as a valid score', () => {
    const value = { ...blankAssessment, body: 0, walk: 0, coat: 0, focus: 0, calm: 0, change: 'UNKNOWN' as const, preScore: 0, preRank: 18, preMark: 'NONE' as const };
    expect(paddockComplete(value)).toBe(true); expect(preComplete(value)).toBe(true);
    expect(paddockComplete({ ...value, calm: null })).toBe(false);
  });
  it('rejects invalid ratings, scores, ranks and oversized comments', () => {
    for (const patch of [{ body: 6 }, { calm: -1 }, { preScore: 101 }, { preRank: 0 }, { preScore: 2.3 }, { change: 'AUTO' }, { paddockComment: 'x'.repeat(1001) }]) expect(assessmentSchema.safeParse({ ...blankAssessment, ...patch }).success).toBe(false);
  });
});

describe('expert assessment API contracts', () => {
  const raceId = '11111111-1111-4111-8111-111111111111';
  const entryId = '22222222-2222-4222-8222-222222222222';
  const horseId = '33333333-3333-4333-8333-333333333333';
  const content = { ...blankAssessment, preScore: 80, preRank: 1, preMark: 'HONMEI' as const };

  it('normalizes dates and exposes only the assessment workspace fields', () => {
    const parsed = expertAssessmentWorkspaceResponseSchema.parse({
      race: { id: raceId, name: '評価試験', venue: '東京', number: 11, startsAt: new Date('2026-09-30T06:00:00.000Z'), status: 'SCHEDULED', revision: 1 },
      entries: [{ id: entryId, horseId, number: 1, horseName: 'テスト馬', status: 'ACTIVE', assessment: { revision: 1, content } }]
    });
    expect(parsed.race.startsAt).toBe('2026-09-30T06:00:00.000Z');
    expect(expertAssessmentWorkspaceResponseSchema.safeParse({ ...parsed, entries: [{ ...parsed.entries[0], jockey: '非公開列' }] }).success).toBe(false);
    expect(expertAssessmentWorkspaceResponseSchema.safeParse({ ...parsed, entries: [{ ...parsed.entries[0], assessment: { ...parsed.entries[0].assessment, updatedBy: raceId } }] }).success).toBe(false);
  });

  it('rejects internal assessment and history fields', () => {
    expect(expertAssessmentSaveResponseSchema.safeParse({ revision: 1, content, updatedBy: raceId }).success).toBe(false);
    const history = { items: [{ revision: 1, content, reason: '評価更新', createdAt: '2026-09-30T06:00:00.000Z' }], total: 1, page: 1, limit: 20 as const };
    expect(expertAssessmentHistoryResponseSchema.safeParse(history).success).toBe(true);
    expect(expertAssessmentHistoryResponseSchema.safeParse({ ...history, items: [{ ...history.items[0], actorId: raceId, entrySnapshot: {} }] }).success).toBe(false);
  });
});
