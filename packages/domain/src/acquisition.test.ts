import { describe, expect, it } from 'vitest';
import { acquisitionCampaignCreateSchema, acquisitionSchema, adminAcquisitionReportResponseSchema, lineOAuthStartSchema, onboardingFunnelResponseSchema, registrationSchema } from './index';

describe('acquisition input', () => {
  it('normalizes bounded campaign fields and rejects URLs or unrelated LINE flows', () => {
    expect(acquisitionSchema.parse({ source: ' LP ', medium: ' Owned ', campaign: '秋開催', landingPath: '/register', referralCode: 'staff_01' })).toEqual({ source: 'lp', medium: 'owned', campaign: '秋開催', landingPath: '/register', referralCode: 'staff_01' });
    expect(acquisitionSchema.safeParse({ source: 'lp', landingPath: 'https://example.test/register' }).success).toBe(false);
    expect(acquisitionSchema.safeParse({ source: 'x'.repeat(101) }).success).toBe(false);
    expect(lineOAuthStartSchema.safeParse({ purpose: 'LOGIN', acquisition: { source: 'lp' } }).success).toBe(false);
    expect(lineOAuthStartSchema.safeParse({ purpose: 'REGISTER', acquisition: { source: 'LP' } }).success).toBe(true);
  });

  it('keeps acquisition optional for direct registration', () => {
    const base = { email: 'member@example.test', password: 'long-password-123', displayName: '会員', adult: true, terms: true, privacy: true, termsVersion: '2026-10-01-v1', privacyVersion: '2026-10-01-v1' };
    expect(registrationSchema.safeParse(base).success).toBe(true);
  });
  it('validates and normalizes campaign creation', () => {
    expect(acquisitionCampaignCreateSchema.parse({ name: ' 秋LP ', code: 'AUTUMN_01', source: ' LP ', medium: ' Owned ', landingPath: '/register', reason: '公開準備' })).toMatchObject({ name: '秋LP', code: 'autumn_01', source: 'lp', medium: 'owned' });
    expect(acquisitionCampaignCreateSchema.safeParse({ name: 'LP', code: '../bad', source: 'lp', medium: 'owned', landingPath: '/register', reason: '検証' }).success).toBe(false);
  });

  it('normalizes the admin report response without exposing unrelated account data', () => {
    const createdAt = new Date('2026-09-27T01:02:03.000Z');
    const since = new Date('2026-08-28T01:02:03.000Z');
    const value = adminAcquisitionReportResponseSchema.parse({
      days: 30,
      since,
      legacyMembers: 2,
      campaigns: [{
        id: '10000000-0000-4000-8000-000000000001',
        name: '秋開催LP',
        code: 'autumn',
        source: 'lp',
        medium: 'owned',
        content: null,
        landingPath: '/register',
        referralCode: null,
        createdBy: '10000000-0000-4000-8000-000000000002',
        createdAt,
        registrationUrl: 'https://example.test/register?utm_source=lp&utm_medium=owned&utm_campaign=autumn'
      }],
      breakdown: [{ source: 'lp', medium: 'owned', campaign: 'autumn', registered: 3, paid: 1 }]
    });
    expect(value.since).toBe(since.toISOString());
    expect(value.campaigns[0]?.createdAt).toBe(createdAt.toISOString());
    expect(adminAcquisitionReportResponseSchema.safeParse({ ...value, email: 'admin@example.test' }).success).toBe(false);
    expect(adminAcquisitionReportResponseSchema.safeParse({ ...value, campaigns: [{ ...value.campaigns[0], creator: { passwordHash: 'secret' } }] }).success).toBe(false);
  });

  it('keeps the onboarding funnel aggregate-only and normalizes its timestamps', () => {
    const since = new Date('2026-08-28T01:02:03.000Z');
    const trackingStartsAt = new Date('2026-09-01T04:05:06.000Z');
    const generatedAt = new Date('2026-09-27T07:08:09.000Z');
    const value = onboardingFunnelResponseSchema.parse({
      days: 30,
      since,
      source: 'lp',
      sources: ['direct', 'lp'],
      stages: [
        { key: 'REGISTERED', label: '無料登録', value: 10, rateFromRegistered: 100, dropOffFromPrevious: 0, rateFromPrevious: 100 },
        { key: 'IDENTITY_READY', label: '本人確認', value: 8, rateFromRegistered: 80, dropOffFromPrevious: 2, rateFromPrevious: 80 },
        { key: 'FIRST_LOGIN', label: '初回ログイン', value: 7, rateFromRegistered: 70, dropOffFromPrevious: 1, rateFromPrevious: 87.5 },
        { key: 'LINE_GUIDANCE_VIEWED', label: 'LINE案内到達', value: 6, rateFromRegistered: 60, dropOffFromPrevious: 1, rateFromPrevious: 85.7 },
        { key: 'LINE_READY', label: 'LINE受信準備', value: 5, rateFromRegistered: 50, dropOffFromPrevious: 1, rateFromPrevious: 83.3 }
      ],
      paid: 2,
      lineAvailable: true,
      trackingStartsAt,
      generatedAt
    });
    expect(value.since).toBe(since.toISOString());
    expect(value.trackingStartsAt).toBe(trackingStartsAt.toISOString());
    expect(value.generatedAt).toBe(generatedAt.toISOString());
    expect(onboardingFunnelResponseSchema.safeParse({ ...value, email: 'member@example.test' }).success).toBe(false);
    expect(onboardingFunnelResponseSchema.safeParse({ ...value, stages: value.stages.map((stage, index) => index ? stage : { ...stage, userId: '10000000-0000-4000-8000-000000000001' }) }).success).toBe(false);
  });
});
