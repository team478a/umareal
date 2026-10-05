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

  it.each(['FREE_REGISTRATION', 'FULL'])('fails safe to the production LP in %s when the Render variable is missing', launchMode => {
    expect(buildMemberReferralUrl('AB12CD34EF', 'https://app.umareal.com', undefined, { nodeEnv: 'production', launchMode })).toBe(
      'https://umareal.com/?invite=AB12CD34EF'
    );
  });

  it('does not send cloud staging referrals to the production LP without an explicit marketing URL', () => {
    expect(buildMemberReferralUrl('AB12CD34EF', 'https://staging.example.test', undefined, { nodeEnv: 'production', launchMode: 'CLOUD_STAGING' })).toBe(
      'https://staging.example.test/register?invite=AB12CD34EF'
    );
  });
});
