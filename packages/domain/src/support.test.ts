import { describe, expect, it } from 'vitest';
import { adminSupportListResponseSchema, adminSupportStatusResponseSchema, adminSupportTriageResponseSchema, memberSupportCreateResponseSchema, memberSupportHistoryResponseSchema, memberSupportMessageResponseSchema, supportEventType, supportMessageSchema, supportRequestSchema, supportStatusSchema, supportTriageSchema } from './support';

describe('general support', () => {
  it('validates a member inquiry without billing information', () => {
    expect(supportRequestSchema.parse({ category: 'TECHNICAL', subject: '画面が開けません', message: 'レース一覧を開くとエラーが表示されます。' })).toMatchObject({ category: 'TECHNICAL' });
    expect(supportRequestSchema.safeParse({ category: 'UNKNOWN', subject: '短い', message: '不足' }).success).toBe(false);
  });

  it('requires a public reply only when resolving', () => {
    expect(supportStatusSchema.safeParse({ status: 'RESOLVED', reason: '確認済み' }).success).toBe(false);
    expect(supportStatusSchema.safeParse({ status: 'RESOLVED', reason: '確認済み', publicReply: '設定を修正しました。もう一度お試しください。' }).success).toBe(true);
    expect(supportStatusSchema.safeParse({ status: 'IN_PROGRESS', reason: '調査開始', publicReply: '途中回答' }).success).toBe(false);
  });

  it('accepts a concise member follow-up and rejects empty or oversized messages', () => {
    expect(supportMessageSchema.parse({ message: '追加で確認したところ、メール通知も届いていません。' }).message).toContain('メール通知');
    expect(supportMessageSchema.safeParse({ message: ' ' }).success).toBe(false);
    expect(supportMessageSchema.safeParse({ message: 'あ'.repeat(2001) }).success).toBe(false);
  });

  it('validates staff triage without accepting arbitrary priority or assignee values', () => {
    expect(supportTriageSchema.parse({ priority: 'URGENT', assignedToId: null, dueAt: '2026-09-18T09:00:00+09:00', reason: '開催日前に確認が必要' })).toMatchObject({ priority: 'URGENT' });
    expect(supportTriageSchema.safeParse({ priority: 'CRITICAL', assignedToId: 'staff', dueAt: null, reason: '' }).success).toBe(false);
  });

  it('allows only explicit workflow transitions', () => {
    expect(supportEventType('OPEN', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(supportEventType('IN_PROGRESS', 'RESOLVED')).toBe('RESOLVED');
    expect(supportEventType('RESOLVED', 'OPEN')).toBe('REOPENED');
    expect(supportEventType('IN_PROGRESS', 'OPEN')).toBeNull();
  });

  it('keeps member support history public and normalizes database dates', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    expect(memberSupportHistoryResponseSchema.parse({ items: [{
      id, category: 'SERVICE', subject: 'サービスについて確認したいです', message: '利用方法について詳しく教えてください。', status: 'OPEN',
      createdAt: new Date('2026-09-29T00:00:00Z'), updatedAt: new Date('2026-09-29T01:00:00Z'),
      events: [{ id, eventType: 'MEMBER_MESSAGE', actorRole: 'MEMBER', publicMessage: '追加で確認したい内容です。', occurredAt: new Date('2026-09-29T00:30:00Z') }]
    }] })).toMatchObject({ items: [{ createdAt: '2026-09-29T00:00:00.000Z', events: [{ occurredAt: '2026-09-29T00:30:00.000Z' }] }] });
  });

  it('rejects staff triage, identity and internal reasons from member history', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const item = {
      id, category: 'SERVICE', subject: 'サービスについて確認したいです', message: '利用方法について詳しく教えてください。', status: 'OPEN',
      createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z', events: []
    };
    for (const privateField of [
      { priority: 'URGENT' }, { assignedToId: id }, { dueAt: '2026-09-30T00:00:00.000Z' },
      { user: { id, email: 'member@example.test' } }
    ]) expect(memberSupportHistoryResponseSchema.safeParse({ items: [{ ...item, ...privateField }] }).success).toBe(false);
    expect(memberSupportHistoryResponseSchema.safeParse({ items: [{ ...item, events: [{ id, eventType: 'RESOLVED', actorRole: 'OPERATOR', publicMessage: '回答です。', occurredAt: '2026-09-29T00:30:00.000Z', reason: '内部調査内容' }] }] }).success).toBe(false);
  });

  it('keeps the administrator queue contract limited to support operations', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const item = {
      id, category: 'TECHNICAL', subject: '画面が開けません', message: 'レース一覧を開くとエラーが表示されます。', status: 'IN_PROGRESS', priority: 'HIGH', assignedToId: id,
      dueAt: new Date('2026-09-30T00:00:00Z'), createdAt: new Date('2026-09-29T00:00:00Z'), updatedAt: new Date('2026-09-29T01:00:00Z'),
      user: { id, displayName: '会員', email: 'member@example.test' },
      assignee: { id, displayName: '担当者', role: 'OPERATOR', disabledAt: null },
      events: [{ id, eventType: 'IN_PROGRESS', actorRole: 'OPERATOR', reason: '調査を開始', publicMessage: null, occurredAt: new Date('2026-09-29T00:30:00Z'), actor: { displayName: '担当者' } }]
    };
    const parsed = adminSupportListResponseSchema.parse({ items: [item], assignees: [{ id, displayName: '担当者', role: 'OPERATOR' }], now: new Date('2026-09-29T02:00:00Z') });
    expect(parsed).toMatchObject({ items: [{ dueAt: '2026-09-30T00:00:00.000Z', events: [{ occurredAt: '2026-09-29T00:30:00.000Z' }] }], now: '2026-09-29T02:00:00.000Z' });
    for (const privateField of [{ passwordHash: 'hash' }, { authSubject: 'subject' }, { mfaSecretEncrypted: 'secret' }, { stripeCustomerId: 'cus_internal' }, { auditLogs: [] }]) {
      expect(adminSupportListResponseSchema.safeParse({ items: [{ ...item, user: { ...item.user, ...privateField } }], assignees: [], now: new Date() }).success).toBe(false);
    }
    expect(adminSupportListResponseSchema.safeParse({ items: [{ ...item, events: [{ ...item.events[0], actor: { displayName: '担当者', email: 'staff@example.test' } }] }], assignees: [], now: new Date() }).success).toBe(false);
  });

  it('normalizes support action responses and rejects internal identifiers', () => {
    const requestId = '10000000-0000-4000-8000-000000000001';
    const eventId = '20000000-0000-4000-8000-000000000002';
    const actorId = '30000000-0000-4000-8000-000000000003';
    const created = { id: requestId, category: 'SERVICE', subject: '利用方法について確認したい', status: 'OPEN', createdAt: new Date('2026-09-29T00:00:00Z') };
    const message = { id: eventId, requestId, status: 'OPEN', reopened: true, occurredAt: new Date('2026-09-29T00:10:00Z') };
    const triage = { id: requestId, priority: 'HIGH', assignedToId: actorId, dueAt: new Date('2026-09-30T00:00:00Z'), updatedAt: new Date('2026-09-29T00:20:00Z'), assignee: { id: actorId, displayName: '担当者', role: 'OPERATOR' } };
    const status = { id: requestId, status: 'IN_PROGRESS', updatedAt: new Date('2026-09-29T00:30:00Z') };
    expect(memberSupportCreateResponseSchema.parse(created).createdAt).toBe('2026-09-29T00:00:00.000Z');
    expect(memberSupportMessageResponseSchema.parse(message).occurredAt).toBe('2026-09-29T00:10:00.000Z');
    expect(adminSupportTriageResponseSchema.parse(triage).dueAt).toBe('2026-09-30T00:00:00.000Z');
    expect(adminSupportStatusResponseSchema.parse(status).updatedAt).toBe('2026-09-29T00:30:00.000Z');
    for (const [schema, value] of [
      [memberSupportCreateResponseSchema, created],
      [memberSupportMessageResponseSchema, message],
      [adminSupportTriageResponseSchema, triage],
      [adminSupportStatusResponseSchema, status]
    ] as const) {
      expect(schema.safeParse({ ...value, userId: actorId }).success).toBe(false);
      expect(schema.safeParse({ ...value, auditLogId: eventId }).success).toBe(false);
      expect(schema.safeParse({ ...value, stripeCustomerId: 'cus_internal' }).success).toBe(false);
    }
  });
});
