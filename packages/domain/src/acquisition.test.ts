import { describe, expect, it } from 'vitest';
import { acquisitionCampaignCreateSchema, acquisitionSchema, adminAcquisitionReportResponseSchema, lineOAuthStartSchema, registrationSchema } from './index';

describe('acquisition input', () => {
  it('normalizes bounded campaign fields and rejects URLs or unrelated LINE flows', () => {
    expect(acquisitionSchema.parse({ source: ' LP ', medium: ' Owned ', campaign: '秋開催', landingPath: '/register', referralCode: 'staff_01' })).toEqual({ source: 'lp', medium: 'owned', campaign: '秋開催', landingPath: '/register', referralCode: 'staff_01' });
    expect(acquisitionSchema.safeParse({ source: 'lp', landingPath: 'https://example.test/register' }).success).toBe(false);
    expect(acquisitionSchema.safeParse({ source: 'x'.repeat(101) }).success).toBe(false);
    expect(lineOAuthStartSchema.safeParse({ purpose: 'LOGIN', acquisition: { source: 'lp' } }).success).toBe(false);
    expect(lineOAuthStartSchema.safeParse({ purpose: 'REGISTER', acquisition: { source: 'LP' } }).success).toBe(true);
  });

  it('keeps acquisition optional for direct registration', () => {
    const base = { email: 'member@example.test', password: 'long-password-123', displayName: '会員', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1' };
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
});
