import { describe, expect, it } from 'vitest';
import { adminOperationsResponseSchema, adminOperationsStepKeys, buildAdminOperationsAttention } from './admin-operations';

describe('admin operations response contract', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const now = new Date('2026-09-29T06:00:00.000Z');
  const steps = adminOperationsStepKeys.map((key, index) => ({
    key,
    label: `手順${index + 1}`,
    state: index < 2 ? 'DONE' as const : index === 2 ? 'CURRENT' as const : index === 5 ? 'NOT_DUE' as const : 'WAITING' as const,
    detail: `確認${index + 1}`
  }));
  const response = {
    date: '2026-09-29',
    generatedAt: now,
    items: [{
      id,
      raceDate: '2026-09-29',
      venue: '東京',
      number: 10,
      name: '運用確認レース',
      status: 'SCHEDULED' as const,
      startsAt: new Date('2026-09-29T06:10:00.000Z'),
      secondsRemaining: 600,
      deadlineState: 'DUE_SOON' as const,
      assignments: [{ id, displayName: '担当者', active: true }],
      entries: { total: 2, paddockCompleted: 1 },
      announcement: { version: 1, publishedAt: now, eventStatus: 'SENT' },
      prediction: null,
      notification: { queued: 0, sent: 1, failed: 0 },
      result: null,
      warnings: ['パドック未完了 1頭'],
      rehearsal: { status: 'IN_PROGRESS' as const, done: 2, total: 6 as const, nextStep: 'PADDOCK' as const, steps }
    }],
    alerts: 1,
    attention: {
      critical: 1,
      warning: 0,
      items: [{ raceId: id, code: 'PUBLICATION_DUE_SOON' as const, severity: 'CRITICAL' as const, title: '東京10R 最終予想の公開が接近', detail: '発走まで10分です。', href: `/expert?race=${id}` }]
    },
    rehearsal: { ready: 0, blocked: 0, total: 1, preflight: { csvImportEnabled: true, predictionPublicationEnabled: true, lineAvailable: true, lineNotificationsEnabled: true, lineConfigured: false } }
  };

  it('preserves the operations board response and normalizes database dates', () => {
    const parsed = adminOperationsResponseSchema.parse(response);
    expect(parsed.generatedAt).toBe('2026-09-29T06:00:00.000Z');
    expect(parsed.items[0].startsAt).toBe('2026-09-29T06:10:00.000Z');
    expect(parsed.items[0].announcement?.publishedAt).toBe('2026-09-29T06:00:00.000Z');
    expect(parsed.items[0].rehearsal.steps.map(step => step.key)).toEqual(adminOperationsStepKeys);
    expect(parsed.attention).toMatchObject({ critical: 1, warning: 0 });
  });

  it('rejects member contacts, horse details, assessment content and connection secrets', () => {
    for (const privateField of ['email', 'lineSubject', 'horseEntries', 'assessmentContent', 'deliveryRecipients', 'lineChannelSecret']) {
      expect(adminOperationsResponseSchema.safeParse({ ...response, [privateField]: 'private' }).success).toBe(false);
    }
    expect(adminOperationsResponseSchema.safeParse({ ...response, items: [{ ...response.items[0], assignments: [{ ...response.items[0].assignments[0], email: 'staff@example.test' }] }] }).success).toBe(false);
    expect(adminOperationsResponseSchema.safeParse({ ...response, rehearsal: { ...response.rehearsal, preflight: { ...response.rehearsal.preflight, lineAccessToken: 'secret' } } }).success).toBe(false);
  });

  it('rejects impossible completion counts and reordered rehearsal steps', () => {
    expect(adminOperationsResponseSchema.safeParse({ ...response, items: [{ ...response.items[0], entries: { total: 1, paddockCompleted: 2 } }] }).success).toBe(false);
    expect(adminOperationsResponseSchema.safeParse({ ...response, items: [{ ...response.items[0], rehearsal: { ...response.items[0].rehearsal, steps: [...steps].reverse() } }] }).success).toBe(false);
    expect(adminOperationsResponseSchema.safeParse({ ...response, attention: { ...response.attention, critical: 0 } }).success).toBe(false);
  });

  it('prioritizes delivery failures and the first stopped workflow step', () => {
    const race = adminOperationsResponseSchema.parse(response).items[0];
    const attention = buildAdminOperationsAttention([{ ...race, notification: { queued: 0, sent: 0, failed: 2 }, deadlineState: 'DUE_SOON', secondsRemaining: 600 }]);
    expect(attention).toMatchObject({ critical: 2, warning: 0 });
    expect(attention.items.map(item => item.code)).toEqual(['DELIVERY_FAILED', 'PADDOCK_INCOMPLETE']);
    expect(attention.items[0].detail).toContain('2件');
  });
});
