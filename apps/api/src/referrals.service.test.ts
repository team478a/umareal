import { afterEach, describe, expect, it } from 'vitest';
import { buildMemberReferralUrl } from './referrals.service';

describe('buildMemberReferralUrl', () => {
  afterEach(() => {
    delete process.env.MARKETING_BASE_URL;
  });

  it('keeps the direct registration URL when no marketing site is configured', () => {
    expect(buildMemberReferralUrl('AB12CD34EF', 'https://app.example.test')).toBe(
      'https://app.example.test/register?invite=AB12CD34EF'
    );
  });

  it('routes production referrals through the marketing LP without losing the code', () => {
    expect(buildMemberReferralUrl('AB12CD34EF', 'https://app.example.test', 'https://umareal.com')).toBe(
      'https://umareal.com/?invite=AB12CD34EF'
    );
  });
});
