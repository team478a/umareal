import { describe, expect, it } from 'vitest';
import { assessmentSchema, blankAssessment, paddockComplete, preComplete } from './assessments';
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
