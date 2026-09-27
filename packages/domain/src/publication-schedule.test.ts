import { describe, expect, it } from 'vitest';
import { publicationScheduleListResponseSchema } from './publication-schedule';

const id = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-09-27T00:00:00.000Z');

function response() {
  const channel = { expandedAt: now, total: 1, queued: 0, sending: 0, sent: 1, failed: 0, skipped: 0 };
  return {
    generatedAt: now,
    items: [{
      id, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走', startsAt: new Date('2026-09-27T06:00:00.000Z'), status: 'SCHEDULED',
      announcements: [{ version: 1, publishedAt: now }],
      freeReportDraft: { revision: 2, updatedAt: now },
      freeReportVersions: [{ version: 1, publishedAt: now }],
      publicationSchedules: [{ id, kind: 'FREE_REPORT_PRE_RACE', draftRevision: 2, scheduledAt: now, status: 'PENDING', reason: '定刻公開', createdAt: now, processedAt: null, errorCode: null, publishedTargetId: null }],
      deliveryResults: [{ eventId: id, contentType: 'RACE_ANNOUNCEMENT', label: '対象レース告知', version: 1, publishedAt: now, eventStatus: 'SENT', line: channel, email: channel }],
      warnings: []
    }],
    alerts: 0,
    failedDeliveries: 0
  } as const;
}

describe('publication schedule list contract', () => {
  it('normalizes the existing list response timestamps', () => {
    const parsed = publicationScheduleListResponseSchema.parse(response());
    expect(parsed.generatedAt).toBe(now.toISOString());
    expect(parsed.items[0]?.publicationSchedules[0]?.scheduledAt).toBe(now.toISOString());
    expect(parsed.items[0]?.deliveryResults[0]?.line.expandedAt).toBe(now.toISOString());
  });

  it('rejects mismatched labels and internal recipient data', () => {
    const value = response();
    expect(publicationScheduleListResponseSchema.safeParse({ ...value, items: [{ ...value.items[0], deliveryResults: [{ ...value.items[0].deliveryResults[0], label: '無料パドック速報' }] }] }).success).toBe(false);
    expect(publicationScheduleListResponseSchema.safeParse({ ...value, items: [{ ...value.items[0], recipientEmail: 'member@example.test' }] }).success).toBe(false);
    expect(publicationScheduleListResponseSchema.safeParse({ ...value, items: [{ ...value.items[0], deliveryResults: [{ ...value.items[0].deliveryResults[0], payload: { secret: 'hidden' } }] }] }).success).toBe(false);
  });
});
