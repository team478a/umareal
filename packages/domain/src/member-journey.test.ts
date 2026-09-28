import { describe, expect, it } from 'vitest';
import { memberJourneyEventSchema, memberJourneyResponseSchema } from './member-journey';

describe('member journey contract', () => {
  it('accepts only the existing member-recordable milestones', () => {
    expect(memberJourneyEventSchema.parse({ eventType: 'PLAN_VIEWED' })).toEqual({ eventType: 'PLAN_VIEWED' });
    expect(memberJourneyEventSchema.safeParse({ eventType: 'FIRST_LOGIN' }).success).toBe(false);
    expect(memberJourneyEventSchema.safeParse({ eventType: 'PLAN_VIEWED', userId: 'internal' }).success).toBe(false);
  });

  it('serializes the existing response without accepting identity fields', () => {
    const response = { eventType: 'CHECKOUT_REVIEWED' as const, occurredAt: new Date('2027-01-02T03:04:05Z'), recorded: true as const };
    expect(memberJourneyResponseSchema.parse(response)).toEqual({ ...response, occurredAt: '2027-01-02T03:04:05.000Z' });
    expect(() => memberJourneyResponseSchema.parse({ ...response, userId: '10000000-0000-4000-8000-000000000001' })).toThrow();
  });
});
