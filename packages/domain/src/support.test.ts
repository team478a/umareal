import { describe, expect, it } from 'vitest';
import { supportEventType, supportMessageSchema, supportRequestSchema, supportStatusSchema, supportTriageSchema } from './support';

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
});
