import { describe, expect, it } from 'vitest';
import { adminNotificationListResponseSchema, adminNotificationTestOptionsResponseSchema, freeReportNotificationPreviewResponseSchema, memberNotificationListResponseSchema, notificationIdempotencyKey, notificationListQuerySchema, notificationRetrySchema, notificationTestSendResponseSchema, notificationTestSendSchema, raceAnnouncementNotificationPreviewResponseSchema, retryDelayMs } from './notifications';

describe('notification operations rules', () => {
  it('builds a recipient and version scoped idempotency key', () => {
    expect(notificationIdempotencyKey({ eventType: 'PREDICTION_PUBLISHED', targetId: 'race', recipientId: 'member', version: 2 })).toBe('LINE:PREDICTION_PUBLISHED:race:member:v2');
    expect(notificationIdempotencyKey({ eventType: 'RACE_ANNOUNCED', targetId: 'race', recipientId: 'member', version: 1, channel: 'EMAIL' })).toBe('EMAIL:RACE_ANNOUNCED:race:member:v1');
  });
  it('uses capped exponential retry delays', () => {
    expect([1, 2, 3].map(attempt => retryDelayMs(30, attempt))).toEqual([30_000, 60_000, 120_000]);
    expect(retryDelayMs(3600, 10)).toBe(86_400_000);
  });
  it('validates filters and requires a manual retry reason', () => {
    expect(notificationListQuerySchema.parse({ status: 'FAILED' })).toMatchObject({ page: 1, limit: 20, status: 'FAILED' });
    expect(notificationListQuerySchema.parse({ channel: 'EMAIL' })).toMatchObject({ page: 1, limit: 20, channel: 'EMAIL' });
    expect(notificationListQuerySchema.parse({ raceId: '11111111-1111-4111-8111-111111111111' })).toMatchObject({ raceId: '11111111-1111-4111-8111-111111111111' });
    expect(() => notificationListQuerySchema.parse({ status: 'UNKNOWN' })).toThrow();
    expect(() => notificationRetrySchema.parse({ reason: ' ' })).toThrow();
  });
  it('requires a frozen draft revision for free-content test sends', () => {
    const common = { raceId: '11111111-1111-4111-8111-111111111111', channel: 'EMAIL', reason: '公開前の文面確認' } as const;
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'RACE_ANNOUNCEMENT' })).toMatchObject({ contentType: 'RACE_ANNOUNCEMENT' });
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'FREE_REPORT_PRE_RACE', draftRevision: 2 })).toMatchObject({ draftRevision: 2 });
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'FREE_REPORT_PRE_RACE' })).toThrow();
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'RACE_ANNOUNCEMENT', draftRevision: 1 })).toThrow();
  });
  it('requires the target that belongs to each operational test type', () => {
    const common = { channel: 'EMAIL', reason: '公開前の文面確認' } as const;
    const id = '11111111-1111-4111-8111-111111111111';
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'CONNECTION_CHECK' })).toMatchObject({ contentType: 'CONNECTION_CHECK' });
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'CONNECTION_CHECK', raceId: id })).toThrow();
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'RACE_PREDICTION', raceId: id })).toMatchObject({ raceId: id });
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'WIN5_PREDICTION', productId: id })).toMatchObject({ productId: id });
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'BILLING_PAYMENT_FAILED', subscriptionId: id })).toMatchObject({ subscriptionId: id });
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'WIN5_PREDICTION', raceId: id })).toThrow();
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'BILLING_PAYMENT_FAILED', productId: id })).toThrow();
  });
  it('normalizes the test-send response and rejects recipient or provider details', () => {
    const response = {
      status: 'SIMULATED', channel: 'EMAIL', transport: 'TEST_ONLY', contentLabel: '対象レース告知', version: 2,
      sentAt: new Date('2026-09-27T00:00:00.000Z')
    } as const;
    expect(notificationTestSendResponseSchema.parse(response)).toEqual({ ...response, sentAt: '2026-09-27T00:00:00.000Z' });
    expect(notificationTestSendResponseSchema.safeParse({ ...response, recipient: 'admin@example.test' }).success).toBe(false);
    expect(notificationTestSendResponseSchema.safeParse({ ...response, providerRequestId: 'secret-provider-id' }).success).toBe(false);
  });
  it('normalizes the admin list response and rejects fields outside the public contract', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const now = new Date('2026-09-27T00:00:00.000Z');
    const response = {
      items: [{
        id, status: 'FAILED' as const, channel: 'EMAIL' as const, attemptCount: 1, manualRetryCount: 0,
        nextAttemptAt: now, lastErrorCode: 'TEST_FAILURE', sentAt: null, createdAt: now, updatedAt: now,
        user: { id, displayName: '通知確認者', email: 'member@example.test' },
        event: {
          id, eventType: 'BILLING_PAYMENT_FAILED', status: 'FAILED', createdAt: now,
          version: null, announcement: null, freeReportVersion: null, productVersion: null,
          raceResultVersion: null, win5EvaluationVersion: null,
          billingEvent: { id, eventType: 'SUBSCRIPTION_PAYMENT_FAILED', subscription: { planCode: 'STANDARD' }, dayPass: null, billingCheckout: { planCode: 'STANDARD' } }
        },
        attempts: [{ id, attemptNumber: 1, outcome: 'PERMANENT_FAILURE', errorCode: 'TEST_FAILURE', startedAt: now, finishedAt: now }]
      }],
      total: 1, page: 1, limit: 20, channel: 'EMAIL' as const, raceId: null, counts: { FAILED: 1 },
      webhook: { lastReceivedAt: null, lastEventType: null, lastOutcome: null, received24h: 0, unmatched24h: 0, blockedAccounts: 0 },
      emailWebhook: {
        lastReceivedAt: now, lastEventType: 'email.failed', lastOutcome: 'MATCHED', received24h: 1, actionRequired24h: 1, blockedAccounts: 1,
        recent: [{ id, eventType: 'email.failed', occurredAt: now, receivedAt: now, recipientCount: 1, matchedCount: 1, disabledCount: 0, outcome: 'MATCHED' }],
        blockedMembers: [{ id, displayName: '通知確認者', email: 'member@example.test', emailDeliveryDisabledAt: now, emailDeliveryDisabledReason: 'BOUNCED' }]
      }
    };
    const parsed = adminNotificationListResponseSchema.parse(response);
    expect(parsed.items[0]?.createdAt).toBe(now.toISOString());
    expect(parsed.emailWebhook.recent[0]?.receivedAt).toBe(now.toISOString());
    expect(adminNotificationListResponseSchema.safeParse({ ...response, databaseUrl: 'postgres://secret' }).success).toBe(false);
    expect(adminNotificationListResponseSchema.safeParse({ ...response, items: [{ ...response.items[0], user: { ...response.items[0].user, authSubject: 'secret-subject' } }] }).success).toBe(false);
  });
  it('keeps administrator test options free of recipient addresses and provider identities', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const response = {
      channels: { email: true, line: false },
      races: [{ id, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走' }],
      products: [{ id, targetDate: '2026-09-27', title: 'WIN5紙面', status: 'DRAFT' }],
      subscriptions: [{ id, planCode: 'STANDARD', status: 'ACTIVE', currentPeriodEndsAt: new Date('2026-10-27T00:00:00.000Z'), user: { displayName: '表示名' } }]
    };
    const parsed = adminNotificationTestOptionsResponseSchema.parse(response);
    expect(parsed.subscriptions[0]?.currentPeriodEndsAt).toBe('2026-10-27T00:00:00.000Z');
    expect(adminNotificationTestOptionsResponseSchema.safeParse({ ...response, email: 'admin@example.test' }).success).toBe(false);
    expect(adminNotificationTestOptionsResponseSchema.safeParse({ ...response, subscriptions: [{ ...response.subscriptions[0], user: { displayName: '表示名', lineSubject: 'secret-subject' } }] }).success).toBe(false);
  });
  it('normalizes the race announcement preview and rejects internal recipient data', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const response = {
      eventType: 'RACE_ANNOUNCED', contentLabel: '対象レース告知', generatedAt: new Date('2026-09-27T00:00:00.000Z'), plannedAt: new Date('2026-09-27T01:00:00.000Z'), timing: 'SCHEDULED', version: 1,
      race: { id, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走', startsAt: new Date('2026-09-27T02:00:00.000Z') },
      audience: { uniqueMembers: 2, totalDeliveries: 3, duplicateChannelMembers: 1, line: { enabled: true, eligibleRecipients: 2, scheduledDeliveries: 2 }, email: { enabled: true, eligibleRecipients: 1, scheduledDeliveries: 1 } },
      message: { type: 'text', text: '対象レースのお知らせ' }
    } as const;
    const parsed = raceAnnouncementNotificationPreviewResponseSchema.parse(response);
    expect(parsed.plannedAt).toBe('2026-09-27T01:00:00.000Z');
    expect(parsed.race.startsAt).toBe('2026-09-27T02:00:00.000Z');
    expect(raceAnnouncementNotificationPreviewResponseSchema.safeParse({ ...response, recipientEmail: 'admin@example.test' }).success).toBe(false);
    expect(raceAnnouncementNotificationPreviewResponseSchema.safeParse({ ...response, audience: { ...response.audience, line: { ...response.audience.line, subject: 'provider-subject' } } }).success).toBe(false);
  });
  it('keeps both free-report preview variants exact and free of draft details', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const common = {
      draftRevision: 2, generatedAt: new Date('2026-09-27T00:00:00.000Z'), plannedAt: new Date('2026-09-27T01:00:00.000Z'), timing: 'IMMEDIATE', version: 2,
      race: { id, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走', startsAt: new Date('2026-09-27T02:00:00.000Z') },
      audience: { uniqueMembers: 1, totalDeliveries: 1, duplicateChannelMembers: 0, line: { enabled: true, eligibleRecipients: 1, scheduledDeliveries: 1 }, email: { enabled: false, eligibleRecipients: 0, scheduledDeliveries: 0 } },
      message: { type: 'text', text: '無料速報のお知らせ' }
    } as const;
    const preRace = freeReportNotificationPreviewResponseSchema.parse({ ...common, eventType: 'FREE_REPORT_PUBLISHED', contentLabel: '無料パドック速報', kind: 'PRE_RACE' });
    const review = freeReportNotificationPreviewResponseSchema.parse({ ...common, eventType: 'FREE_REPORT_REVIEW_PUBLISHED', contentLabel: 'レース後検証', kind: 'POST_RACE_REVIEW' });
    expect(preRace.kind).toBe('PRE_RACE');
    expect(review.kind).toBe('POST_RACE_REVIEW');
    expect(freeReportNotificationPreviewResponseSchema.safeParse({ ...common, eventType: 'FREE_REPORT_REVIEW_PUBLISHED', contentLabel: 'レース後検証', kind: 'PRE_RACE' }).success).toBe(false);
    expect(freeReportNotificationPreviewResponseSchema.safeParse({ ...common, eventType: 'FREE_REPORT_PUBLISHED', contentLabel: '無料パドック速報', kind: 'PRE_RACE', upReason: '内部下書き' }).success).toBe(false);
  });
  it('normalizes each member notification target without exposing internal event data', () => {
    const raceId = '11111111-1111-4111-8111-111111111111';
    const productId = '22222222-2222-4222-8222-222222222222';
    const requestId = '33333333-3333-4333-8333-333333333333';
    const common = {
      id: '44444444-4444-4444-8444-444444444444', eventType: 'PREDICTION_PUBLISHED', title: '公開しました',
      createdAt: new Date('2026-09-27T00:00:00.000Z'), publishedAt: new Date('2026-09-27T01:00:00.000Z'),
      version: 1, visibility: 'FREE' as const, readAt: null
    };
    const race = { id: raceId, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走', startsAt: new Date('2026-09-27T02:00:00.000Z') };
    const raceItem = { ...common, href: `/races/${raceId}`, race, win5: null };
    const win5Item = { ...common, href: `/win5/${productId}`, race: null, win5: { id: productId, targetDate: '2026-09-27', title: 'WIN5紙面' } };
    const supportItem = { ...common, href: '/support', race: null, win5: null, support: { requestId, subject: '通知について' } };
    const billingItem = { ...common, href: '/account', race: null, win5: null, billing: { planCode: 'DAY_PASS', raceDate: '2026-09-27' } };
    const contentId = '55555555-5555-4555-8555-555555555555';
    const contentItem = { ...common, href: `/content/${contentId}`, race: null, win5: null, content: { id: contentId, kind: 'ARTICLE', title: '公開記事', category: '読み物' } };
    const parsed = memberNotificationListResponseSchema.parse({ items: [raceItem, win5Item, supportItem, billingItem, contentItem], total: 5, unreadCount: 5, page: 1, limit: 20 });
    expect(parsed.items[0]?.createdAt).toBe('2026-09-27T00:00:00.000Z');
    expect(parsed.items[0]?.race?.startsAt).toBe('2026-09-27T02:00:00.000Z');
    expect(memberNotificationListResponseSchema.safeParse({ items: [{ ...raceItem, payload: { secret: true } }], total: 1, unreadCount: 1, page: 1, limit: 20 }).success).toBe(false);
    expect(memberNotificationListResponseSchema.safeParse({ items: [{ ...raceItem, contentSnapshot: { horse: '非公開' } }], total: 1, unreadCount: 1, page: 1, limit: 20 }).success).toBe(false);
    expect(memberNotificationListResponseSchema.safeParse({ items: [{ ...contentItem, href: '/content/wrong' }], total: 1, unreadCount: 1, page: 1, limit: 20 }).success).toBe(false);
  });
  it('rejects a mismatched or ambiguous member notification destination', () => {
    const raceId = '11111111-1111-4111-8111-111111111111';
    const base = {
      id: '44444444-4444-4444-8444-444444444444', eventType: 'PREDICTION_PUBLISHED', title: '公開しました',
      createdAt: '2026-09-27T00:00:00.000Z', publishedAt: '2026-09-27T01:00:00.000Z', version: 1, visibility: 'FREE' as const,
      readAt: null, race: { id: raceId, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走', startsAt: '2026-09-27T02:00:00.000Z' }, win5: null
    };
    expect(memberNotificationListResponseSchema.safeParse({ items: [{ ...base, href: '/account' }], total: 1, unreadCount: 1, page: 1, limit: 20 }).success).toBe(false);
    expect(memberNotificationListResponseSchema.safeParse({ items: [{ ...base, href: `/races/${raceId}`, billing: { planCode: 'DAY_PASS', raceDate: null } }], total: 1, unreadCount: 1, page: 1, limit: 20 }).success).toBe(false);
  });
});
