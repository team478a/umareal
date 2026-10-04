import { describe, expect, it } from 'vitest';
import { adminSettingsResponseSchema } from './admin-settings';

describe('administrator settings response contract', () => {
  const response = {
    revision: 4,
    operations: { newRegistrationsEnabled: true, emailNotificationsEnabled: true, predictionPublicationEnabled: true, csvImportEnabled: true, lineNotificationsEnabled: false, lineLoginEnabled: false, newPurchasesEnabled: false },
    registrationPauseMessage: '',
    captcha: {
      enabled: false, siteKey: null, secretConfigured: false, connectionStatus: 'DISABLED' as const,
      readiness: { siteKeyStored: false, secretStored: false, secretReadable: false, serverValidationReady: true, transport: 'TEST_ONLY' as const, externalConnectionTested: false }
    },
    maintenanceMessage: '',
    notificationPolicy: { maxAttempts: 5, baseDelaySeconds: 30 },
    publicationPolicy: { correction: 'ADMIN_ONLY' as const, delayedRace: 'CLOSED' as const },
    contentAccess: { monthly: { paddock: true, win5: true, racePaper: true }, dayPass: { paddock: true, win5: true, racePaper: true }, manual: { paddock: true, win5: true, racePaper: true } },
    environment: {
      launchMode: 'FULL', authProvider: 'LOCAL_DEVELOPMENT' as const, applicationUrl: 'http://localhost:3000',
      adminUrlConfigured: false, supabaseConfigured: false, sentryConfigured: false,
      transports: { captcha: 'test', mail: 'test', lineNotifications: 'test', lineLogin: 'test', billing: 'test' }
    },
    billing: { founderSalesEnabled: false, standardSalesEnabled: true, dayPassSalesEnabled: true, founderPriceYen: 1980, standardPriceYen: 2980, dayPassPriceYen: 980, founderSalesLimit: 100, billingGraceDays: 0 },
    stripe: {
      source: 'ENVIRONMENT' as const, liveMode: false, secretKeyConfigured: false, webhookSecretConfigured: false,
      priceFounder: null, priceStandard: null, priceDayPass: null, connectionStatus: 'NOT_CONFIGURED' as const,
      readiness: { credentialsStored: false, secretsReadable: false, pricesConfigured: false, modeConsistent: true, billingTransport: 'TEST_ONLY' as const, externalConnectionTested: false }
    },
    mail: {
      source: 'ENVIRONMENT' as const, apiKeyConfigured: false, webhookSecretConfigured: false, from: null, connectionStatus: 'NOT_CONFIGURED' as const,
      readiness: { credentialsStored: false, secretReadable: false, webhookSecretStored: false, webhookSecretReadable: false, senderConfigured: false, webhookReceiverReady: true, mailTransport: 'TEST_ONLY' as const, externalConnectionTested: false }
    },
    line: {
      channelId: null, channelSecretConfigured: false, channelAccessTokenConfigured: false, connectionStatus: 'NOT_CONFIGURED' as const,
      messagingReadiness: { credentialsStored: false, secretsReadable: false, applicationUrlReady: true, notificationWorkerReady: true, webhookSignatureVerifierReady: true, outboundTransport: 'TEST_ONLY' as const, externalConnectionTested: false },
      loginChannelId: null, loginChannelSecretConfigured: false, loginCallbackUrl: null, loginConnectionStatus: 'NOT_CONFIGURED' as const,
      loginReadiness: { credentialsStored: false, secretReadable: false, callbackUrlConfigured: false, oauthCallbackHandlerReady: true, oauthTransport: 'TEST_ONLY' as const, externalConnectionTested: false }
    },
    updatedAt: new Date('2026-09-29T00:00:00.000Z'),
    updatedBy: null
  };

  it('preserves the existing read and update response', () => {
    const parsed = adminSettingsResponseSchema.parse(response);
    expect(parsed.updatedAt).toBe('2026-09-29T00:00:00.000Z');
    expect(parsed.billing.standardPriceYen).toBe(2980);
    expect(parsed.environment.transports.billing).toBe('test');
  });

  it('rejects credentials, encrypted values and audit details', () => {
    for (const privateField of ['secretKey', 'webhookSecret', 'secretKeyEncrypted', 'webhookSecretEncrypted']) {
      expect(adminSettingsResponseSchema.safeParse({ ...response, stripe: { ...response.stripe, [privateField]: 'secret' } }).success).toBe(false);
    }
    for (const privateField of ['apiKey', 'webhookSecret', 'apiKeyEncrypted']) {
      expect(adminSettingsResponseSchema.safeParse({ ...response, mail: { ...response.mail, [privateField]: 'secret' } }).success).toBe(false);
    }
    for (const privateField of ['channelSecret', 'channelAccessToken', 'loginChannelSecret']) {
      expect(adminSettingsResponseSchema.safeParse({ ...response, line: { ...response.line, [privateField]: 'secret' } }).success).toBe(false);
    }
    expect(adminSettingsResponseSchema.safeParse({ ...response, auditLogs: [] }).success).toBe(false);
  });
});
