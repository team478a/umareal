import { describe, expect, it } from 'vitest';
import { publicAuthConfigResponseSchema } from './public-auth-config';

describe('public authentication configuration response contract', () => {
  const response = {
    provider: 'local' as const,
    localOnly: true,
    launchMode: 'FULL' as const,
    capabilities: { emailRegistration: true as const, freeContent: true as const, lineLogin: true, lineNotifications: true, billing: true },
    registration: { enabled: true, message: '' },
    captcha: { enabled: false, siteKey: null, mode: 'TEST_ONLY' as const },
    emailNotificationsEnabled: true,
    lineEnabled: false,
    lineNotificationsEnabled: false,
    aiRaceGuideEnabled: false
  };

  it('preserves the existing public launch and registration response', () => {
    expect(publicAuthConfigResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects provider credentials and internal settings', () => {
    for (const privateField of ['supabaseAnonKey', 'supabaseServiceRoleKey', 'turnstileSecret', 'lineChannelSecret', 'stripeSecretKey', 'databaseUrl']) {
      expect(publicAuthConfigResponseSchema.safeParse({ ...response, [privateField]: 'secret' }).success).toBe(false);
    }
    expect(publicAuthConfigResponseSchema.safeParse({ ...response, operations: { newRegistrationsEnabled: true } }).success).toBe(false);
  });
});
