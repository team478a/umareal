import { describe, expect, it } from 'vitest';
import { emptyPredictionDraft, expertPredictionDraftSaveResponseSchema, expertPredictionEditorResponseSchema, expertPredictionPreviewResponseSchema, expertPredictionPublishResponseSchema, legacyPredictionDraftSchema, predictionDraftSchema, publicPredictionResponseSchema, publishablePredictionSchema, totalYenFor } from './predictions';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const current = { ...emptyPredictionDraft, visibility: 'PAID' as const, confidence: 'A' as const, summary: '展開と適性を評価', marks: [{ entryId, mark: 'HONMEI' as const, reason: '最終本命として評価' }] };
const legacy = { visibility: 'PAID' as const, confidence: 'A' as const, stance: 'NORMAL' as const, summary: '旧総評', marks: current.marks, bets: [{ type: 'EXACTA' as const, combinations: [[1, 2], [1, 3]], amountPerPointYen: 500 }] };

describe('current horse-evaluation prediction validation', () => {
  it('keeps drafts partial and requires final opinion and one main horse', () => {
    expect(predictionDraftSchema.safeParse(emptyPredictionDraft).success).toBe(true);
    expect(publishablePredictionSchema.safeParse(emptyPredictionDraft).success).toBe(false);
    expect(publishablePredictionSchema.safeParse(current).success).toBe(true);
    expect(publishablePredictionSchema.safeParse({ ...current, marks: [] }).success).toBe(false);
  });

  it('allows a formal skip only without horse evaluations', () => {
    expect(publishablePredictionSchema.safeParse({ ...current, confidence: 'SKIP', marks: [] }).success).toBe(true);
    expect(publishablePredictionSchema.safeParse({ ...current, confidence: 'SKIP' }).success).toBe(false);
  });

  it('rejects duplicate horses and requires every selected horse reason', () => {
    expect(predictionDraftSchema.safeParse({ ...current, marks: [current.marks[0], { ...current.marks[0], mark: 'TAIKO' }] }).success).toBe(false);
    expect(predictionDraftSchema.safeParse({ ...current, marks: [{ ...current.marks[0], reason: '' }] }).success).toBe(false);
  });
});

describe('dormant legacy betting validation', () => {
  it('keeps old snapshots verifiable without using them in the current schema', () => {
    expect(legacyPredictionDraftSchema.safeParse(legacy).success).toBe(true);
    expect(totalYenFor(legacy)).toBe(1000);
    expect(predictionDraftSchema.safeParse(legacy).success).toBe(false);
  });
});

describe('public prediction response contract', () => {
  const race = { id: '11111111-1111-4111-8111-111111111111', name: '公開予想試験', venue: '中山', number: 11, startsAt: new Date('2026-09-27T06:00:00.000Z') };
  const metadata = {
    id: '22222222-2222-4222-8222-222222222222', version: 1, status: 'PUBLISHED' as const, visibility: 'PAID' as const,
    publishedAt: new Date('2026-09-27T05:00:00.000Z'), previousVersionId: null
  };

  it('keeps unpublished and locked responses free of prediction details', () => {
    const unpublished = publicPredictionResponseSchema.parse({ race, latest: null, versions: [], total: 0, page: 1, limit: 20, locked: false });
    expect(unpublished.race.startsAt).toBe('2026-09-27T06:00:00.000Z');
    const locked = { ...metadata, locked: true as const };
    expect(publicPredictionResponseSchema.parse({ race, latest: locked, versions: [locked], total: 1, page: 1, limit: 20, locked: true }).latest?.locked).toBe(true);
    expect(publicPredictionResponseSchema.safeParse({ race, latest: { ...locked, summary: '非公開本文' }, versions: [locked], total: 1, page: 1, limit: 20, locked: true }).success).toBe(false);
  });

  it('normalizes full versions while rejecting database-only prediction fields', () => {
    const full = {
      ...metadata, locked: false as const, confidence: 'A' as const, formatVersion: 'HORSE_EVALUATION_V1', summary: '公開本文', assessmentSnapshot: {},
      publisherId: '33333333-3333-4333-8333-333333333333', deadlineAt: new Date('2026-09-27T06:00:00.000Z'), correctionReason: null,
      marks: [{ id: '44444444-4444-4444-8444-444444444444', versionId: metadata.id, entryId, horseId: '55555555-5555-4555-8555-555555555555', horseNumber: 6, horseName: '試験馬', mark: 'HONMEI' as const, reason: '中心馬として評価' }]
    };
    const response = { race, latest: full, versions: [full], total: 1, page: 1, limit: 20, locked: false };
    const parsed = publicPredictionResponseSchema.parse(response);
    expect(parsed.latest?.publishedAt).toBe('2026-09-27T05:00:00.000Z');
    expect(publicPredictionResponseSchema.safeParse({ ...response, latest: { ...full, contentSnapshot: { secret: true } } }).success).toBe(false);
    expect(publicPredictionResponseSchema.safeParse({ ...response, latest: { ...full, bets: [{ amountPerPointYen: 100 }] } }).success).toBe(false);
  });
});

describe('expert prediction editor response contract', () => {
  const response = {
    race: { id: '11111111-1111-4111-8111-111111111111', name: '編集予想試験', venue: '中山', number: 11, startsAt: new Date('2026-09-27T06:00:00.000Z'), status: 'SCHEDULED' as const, revision: 2 },
    entries: [{ id: entryId, number: 6, horseName: '試験馬', status: 'ACTIVE' as const, assessment: { content: { change: 'UP' as const, paddockComment: '歩様が良い' } } }],
    prediction: { id: '22222222-2222-4222-8222-222222222222', revision: 1, draft: current },
    versions: [{ id: '33333333-3333-4333-8333-333333333333', version: 1, status: 'PUBLISHED' as const, confidence: 'A' as const, summary: '公開済み見解', publishedAt: new Date('2026-09-27T05:00:00.000Z'), correctionReason: null }],
    correctionPolicy: 'ADMIN_ONLY' as const
  };

  it('normalizes dates while retaining the existing editor data', () => {
    const parsed = expertPredictionEditorResponseSchema.parse(response);
    expect(parsed.race.startsAt).toBe('2026-09-27T06:00:00.000Z');
    expect(parsed.versions[0].publishedAt).toBe('2026-09-27T05:00:00.000Z');
    expect(parsed.entries[0].assessment?.content).toEqual({ change: 'UP', paddockComment: '歩様が良い' });
    expect(expertPredictionEditorResponseSchema.parse({ ...response, prediction: null, versions: [] }).prediction).toBeNull();
  });

  it('rejects database-only entry, assessment and publication fields', () => {
    expect(expertPredictionEditorResponseSchema.safeParse({ ...response, entries: [{ ...response.entries[0], horseId: '44444444-4444-4444-8444-444444444444' }] }).success).toBe(false);
    expect(expertPredictionEditorResponseSchema.safeParse({ ...response, entries: [{ ...response.entries[0], assessment: { ...response.entries[0].assessment, updatedBy: '55555555-5555-4555-8555-555555555555' } }] }).success).toBe(false);
    expect(expertPredictionEditorResponseSchema.safeParse({ ...response, versions: [{ ...response.versions[0], publisherId: '66666666-6666-4666-8666-666666666666' }] }).success).toBe(false);
    expect(expertPredictionEditorResponseSchema.safeParse({ ...response, versions: [{ ...response.versions[0], marks: [] }] }).success).toBe(false);
  });
});

describe('expert prediction write response contracts', () => {
  const predictionId = '22222222-2222-4222-8222-222222222222';
  const previewId = '33333333-3333-4333-8333-333333333333';
  const versionId = '44444444-4444-4444-8444-444444444444';

  it('normalizes draft-save and preview dates without exposing internal fields', () => {
    const saved = expertPredictionDraftSaveResponseSchema.parse({ id: predictionId, revision: 1, draft: current, updatedAt: new Date('2026-09-27T04:00:00.000Z') });
    expect(saved.updatedAt).toBe('2026-09-27T04:00:00.000Z');
    expect(expertPredictionDraftSaveResponseSchema.safeParse({ ...saved, updatedBy: versionId }).success).toBe(false);

    const preview = expertPredictionPreviewResponseSchema.parse({
      previewId, expiresAt: new Date('2026-09-27T04:15:00.000Z'), version: 1, correction: false, correctionReason: '', warnings: ['パドック未入力：6番'],
      deadlineAt: new Date('2026-09-27T06:00:00.000Z'), draft: current, entries: [{ id: entryId, number: 6, horseName: '試験馬' }]
    });
    expect(preview.expiresAt).toBe('2026-09-27T04:15:00.000Z');
    expect(expertPredictionPreviewResponseSchema.safeParse({ ...preview, actorId: versionId }).success).toBe(false);
    expect(expertPredictionPreviewResponseSchema.safeParse({ ...preview, entries: [{ ...preview.entries[0], horseId: versionId }] }).success).toBe(false);
  });

  it('keeps initial publication and idempotent replay responses distinct', () => {
    const published = expertPredictionPublishResponseSchema.parse({ published: true, versionId, version: 1, alreadyPublished: false, publishedAt: new Date('2026-09-27T05:00:00.000Z') });
    expect(published).toMatchObject({ version: 1, alreadyPublished: false, publishedAt: '2026-09-27T05:00:00.000Z' });
    expect(expertPredictionPublishResponseSchema.parse({ published: true, versionId, alreadyPublished: true })).toEqual({ published: true, versionId, alreadyPublished: true });
    expect(expertPredictionPublishResponseSchema.safeParse({ ...published, notificationEventId: predictionId }).success).toBe(false);
  });
});
