import { describe, expect, it } from 'vitest';
import type { AdminNotificationDelivery } from '@keiba/domain';
import { adminNotificationDisplay } from './admin-notification-display';

const id = '10000000-0000-4000-8000-000000000001';
const emptyEvent: AdminNotificationDelivery['event'] = {
  id,
  eventType: 'SUPPORT_RESPONSE_POSTED',
  status: 'QUEUED',
  createdAt: '2026-09-29T00:00:00.000Z',
  version: null,
  announcement: null,
  freeReportVersion: null,
  productVersion: null,
  raceResultVersion: null,
  win5EvaluationVersion: null,
  billingEvent: null
};

describe('admin notification display', () => {
  it('shows a support response without assuming a race target', () => {
    expect(adminNotificationDisplay(emptyEvent)).toEqual({
      title: 'お問い合わせへの回答',
      detail: '会員への回答通知',
      targetDate: '会員本人宛て'
    });
  });

  it('keeps an unknown relationless notification renderable', () => {
    expect(adminNotificationDisplay({ ...emptyEvent, eventType: 'FUTURE_MEMBER_NOTICE' })).toEqual({
      title: '会員向け通知',
      detail: 'FUTURE_MEMBER_NOTICE',
      targetDate: '会員本人宛て'
    });
  });
});
