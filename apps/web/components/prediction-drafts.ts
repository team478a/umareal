import { predictionDraftSchema, type PredictionDraft } from '@keiba/domain';

export type PredictionEditorDraft = {
  predictionRevision: number;
  raceRevision: number;
  draft: PredictionDraft;
  reason: string;
  correctionReason: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

export function predictionEditorDraftKey(userId: string, raceId: string) {
  return `keiba:prediction-editor:${userId}:${raceId}`;
}

export function encodePredictionEditorDraft(value: PredictionEditorDraft) {
  return JSON.stringify({ version: 1, ...value });
}

export function parsePredictionEditorDraft(raw: string | null): PredictionEditorDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1
      || !Number.isInteger(value.predictionRevision) || Number(value.predictionRevision) < 0
      || !Number.isInteger(value.raceRevision) || Number(value.raceRevision) <= 0
      || !text(value.reason, 500) || !text(value.correctionReason, 500)) return null;
    const draft = predictionDraftSchema.safeParse(value.draft);
    if (!draft.success) return null;
    return {
      predictionRevision: value.predictionRevision as number,
      raceRevision: value.raceRevision as number,
      draft: draft.data,
      reason: value.reason,
      correctionReason: value.correctionReason,
    };
  } catch { return null; }
}

export function isPredictionEditorDraftCurrent(value: PredictionEditorDraft, predictionRevision: number, raceRevision: number) {
  return value.predictionRevision === predictionRevision && value.raceRevision === raceRevision;
}
