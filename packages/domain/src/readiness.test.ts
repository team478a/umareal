import { describe, expect, it } from 'vitest';
import { adminReadinessResponseSchema } from './readiness';

describe('admin readiness API contract', () => {
  it('normalizes server dates and rejects fields outside the public response', () => {
    const generatedAt = new Date('2026-09-26T01:02:03.000Z');
    const response = {
      generatedAt,
      status: 'NOT_READY' as const,
      counts: { ready: 0, blocked: 1, manual: 0, total: 1 },
      checks: [{
        code: 'PRODUCTION_AUTH' as const,
        group: 'APPLICATION' as const,
        status: 'BLOCKED' as const,
        title: '本番認証',
        evidence: 'Supabase設定が不足しています。',
        action: '実環境で認証を確認します。'
      }],
      nextActions: ['PRODUCTION_AUTH' as const],
      settingsUpdatedAt: '2026-09-26T00:00:00.000Z',
      declaration: 'この自動判定だけで本番公開を承認しません。'
    };
    expect(adminReadinessResponseSchema.parse(response).generatedAt).toBe(generatedAt.toISOString());
    expect(adminReadinessResponseSchema.safeParse({ ...response, databaseUrl: 'postgresql://private' }).success).toBe(false);
    expect(adminReadinessResponseSchema.safeParse({ ...response, checks: [{ ...response.checks[0], secret: 'private' }] }).success).toBe(false);
  });
});
