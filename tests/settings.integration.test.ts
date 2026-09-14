import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptyPredictionDraft, raceHeaders } from '../packages/domain/src';
import { assessmentFixture } from './assessment-fixtures';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('audited administration settings', () => {
  it('protects secrets, detects stale edits, and enforces emergency stops', async () => {
    const memberFixture = await account(); const member = new Client(); await member.login(memberFixture);
    expect((await member.call('admin/settings')).status).toBe(403);

    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/settings')).body.code).toBe('MFA_REQUIRED');
    await admin.mfa();
    const initial = await admin.call('admin/settings'); expect(initial.status).toBe(200);

    const fixture = await assessmentFixture();
    await db.prediction.create({ data: { raceId: fixture.race.id, revision: 1, updatedBy: fixture.owner.user.id, draft: { ...emptyPredictionDraft, visibility: 'FREE', confidence: 'A', stance: 'SKIP', summary: '停止確認', marks: [], bets: [] } } });
    const channelSecret = '0123456789abcdef0123456789abcdef'; const channelAccessToken = `test-token-${'x'.repeat(40)}`; const loginChannelSecret = 'abcdef0123456789abcdef0123456789';
    const stripeSecretKey = `sk_test_${'x'.repeat(32)}`; const stripeWebhookSecret = `whsec_${'y'.repeat(32)}`;
    const stoppedBody = {
      revision: initial.body.revision, reason: '緊急停止とLINE設定の結合試験',
      operations: { newRegistrationsEnabled: false, emailNotificationsEnabled: false, predictionPublicationEnabled: false, csvImportEnabled: false, lineNotificationsEnabled: true, lineLoginEnabled: true, newPurchasesEnabled: false },
      registrationPauseMessage: '募集人数の確認中です。受付再開までお待ちください。',
      maintenanceMessage: '結合試験中', notificationPolicy: { maxAttempts: 4, baseDelaySeconds: 45 },
      billing: { founderSalesEnabled: false, founderPriceYen: 1980, standardPriceYen: 2980, dayPassPriceYen: 980, founderSalesLimit: 100, billingGraceDays: 0 },
      stripe: { liveMode: false, secretKey: stripeSecretKey, webhookSecret: stripeWebhookSecret, clearSecretKey: false, clearWebhookSecret: false, priceFounder: 'price_Founder123', priceStandard: 'price_Standard123', priceDayPass: 'price_DayPass123' },
      line: { channelId: '1234567890', channelSecret, channelAccessToken, clearChannelSecret: false, clearChannelAccessToken: false, loginChannelId: '9876543210', loginChannelSecret, loginCallbackUrl: 'https://example.test/api/v1/auth/line/callback', clearLoginChannelSecret: false }
    };
    const stopped = await admin.call('admin/settings', 'PATCH', stoppedBody); expect(stopped.status).toBe(200);
    expect(stopped.body.line).toMatchObject({ channelSecretConfigured: true, channelAccessTokenConfigured: true, connectionStatus: 'CONFIGURED_NOT_VERIFIED' });
    expect(stopped.body.line).toMatchObject({ loginChannelSecretConfigured: true, loginConnectionStatus: 'CONFIGURED_NOT_VERIFIED' });
    expect(stopped.body.line.messagingReadiness).toMatchObject({ credentialsStored: true, secretsReadable: true, applicationUrlReady: true, notificationWorkerReady: true, webhookSignatureVerifierReady: true, outboundTransport: 'TEST_ONLY', externalConnectionTested: false });
    expect(stopped.body.line.loginReadiness).toMatchObject({ credentialsStored: true, secretReadable: true, callbackUrlConfigured: true, oauthCallbackHandlerReady: true, oauthTransport: 'TEST_ONLY', externalConnectionTested: false });
    expect(stopped.body.stripe).toMatchObject({ source: 'ADMIN', secretKeyConfigured: true, webhookSecretConfigured: true, connectionStatus: 'CONFIGURED_NOT_VERIFIED' });
    expect(stopped.body.stripe.readiness).toMatchObject({ credentialsStored: true, secretsReadable: true, pricesConfigured: true, modeConsistent: true, billingTransport: 'TEST_ONLY', externalConnectionTested: false });
    expect(JSON.stringify(stopped.body)).not.toContain(channelSecret); expect(JSON.stringify(stopped.body)).not.toContain(channelAccessToken); expect(JSON.stringify(stopped.body)).not.toContain(loginChannelSecret); expect(JSON.stringify(stopped.body)).not.toContain(stripeSecretKey); expect(JSON.stringify(stopped.body)).not.toContain(stripeWebhookSecret);
    const stored = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    expect(stored.lineChannelSecretEncrypted).not.toContain(channelSecret); expect(stored.lineAccessTokenEncrypted).not.toContain(channelAccessToken); expect(stored.lineLoginChannelSecretEncrypted).not.toContain(loginChannelSecret);
    expect(stored.stripeSecretKeyEncrypted).not.toContain(stripeSecretKey); expect(stored.stripeWebhookSecretEncrypted).not.toContain(stripeWebhookSecret);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SYSTEM_SETTINGS_UPDATE', targetId: 'global' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit.details)).not.toContain(channelSecret); expect(JSON.stringify(audit.details)).not.toContain(channelAccessToken); expect(JSON.stringify(audit.details)).not.toContain(loginChannelSecret); expect(JSON.stringify(audit.details)).not.toContain(stripeSecretKey); expect(JSON.stringify(audit.details)).not.toContain(stripeWebhookSecret);

    const publicConfig = await new Client().call('auth/config');
    expect(publicConfig.body.registration).toEqual({ enabled: false, message: stoppedBody.registrationPauseMessage });
    expect(publicConfig.body.emailNotificationsEnabled).toBe(false);
    const pausedEmail = `paused-${randomUUID()}@example.test`;
    const paused = await new Client().call('auth/register', 'POST', { email: pausedEmail, displayName: '停止中登録', password: 'integration-password-123', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1' });
    expect(paused.status).toBe(503); expect(paused.body).toMatchObject({ code: 'REGISTRATION_PAUSED', message: stoppedBody.registrationPauseMessage });
    expect(await db.user.findUnique({ where: { email: pausedEmail } })).toBeNull();
    expect((await new Client().call('auth/line/start', 'POST', { purpose: 'REGISTER' })).body.code).toBe('REGISTRATION_PAUSED');
    expect((await new Client().call('auth/login', 'POST', { email: memberFixture.user.email, password: memberFixture.password })).status).toBe(201);

    const publish = await fixture.client.call(`expert/races/${fixture.race.id}/prediction/preview`, 'POST', { predictionRevision: 1, raceRevision: fixture.race.revision, correctionReason: '' });
    expect(publish.body.code).toBe('PREDICTION_PUBLICATION_STOPPED');
    const day = '2094-01-01'; const row: Record<string, unknown> = { raceDate: day, venue: '東京', number: 1, name: `CSV停止試験-${randomUUID().slice(0, 6)}`, raceClass: '未勝利', distance: 1600, surface: 'TURF', direction: 'LEFT', startsAt: `${day}T10:00:00+09:00`, going: 'GOOD', weather: '晴', status: 'SCHEDULED', expertId: fixture.owner.user.id };
    const csv = [raceHeaders.join(','), raceHeaders.map(field => String(row[field] ?? '')).join(',')].join('\n');
    expect((await admin.call('admin/races/import/preview', 'POST', { kind: 'races', csv })).body.code).toBe('CSV_IMPORT_STOPPED');
    expect((await admin.call('admin/settings', 'PATCH', stoppedBody)).body.code).toBe('STALE_REVISION');

    const restored = await admin.call('admin/settings', 'PATCH', {
      ...stoppedBody, revision: stopped.body.revision, reason: '結合試験後に通常運用へ復帰',
      operations: { newRegistrationsEnabled: true, emailNotificationsEnabled: true, predictionPublicationEnabled: true, csvImportEnabled: true, lineNotificationsEnabled: false, lineLoginEnabled: false, newPurchasesEnabled: false },
      registrationPauseMessage: '',
      maintenanceMessage: '', stripe: { liveMode: false, clearSecretKey: true, clearWebhookSecret: true, priceFounder: null, priceStandard: null, priceDayPass: null }, line: { channelId: null, clearChannelSecret: true, clearChannelAccessToken: true, loginChannelId: null, loginCallbackUrl: null, clearLoginChannelSecret: true }
    });
    expect(restored.status).toBe(200); expect(restored.body.line.connectionStatus).toBe('NOT_CONFIGURED');
    expect(restored.body.stripe.connectionStatus).toBe('NOT_CONFIGURED');
    expect((await new Client().call('auth/config')).body.registration).toEqual({ enabled: true, message: '' });
    const resumedEmail = `resumed-${randomUUID()}@example.test`;
    expect((await new Client().call('auth/register', 'POST', { email: resumedEmail, displayName: '再開後登録', password: 'integration-password-123', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1' })).status).toBe(201);
    await expect(db.systemSetting.update({ where: { id: 'global' }, data: { newRegistrationsEnabled: false, registrationPauseMessage: '' } })).rejects.toThrow();
    await expect(db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: true } })).rejects.toThrow();
    await expect(db.systemSetting.update({ where: { id: 'global' }, data: { lineLoginEnabled: true } })).rejects.toThrow();
    await expect(db.systemSetting.update({ where: { id: 'global' }, data: { stripeLiveMode: true } })).rejects.toThrow();
    const operator = new Client(); await operator.login(await account('OPERATOR')); expect((await operator.call('admin/settings')).status).toBe(200); expect((await operator.call('admin/settings', 'PATCH', { ...stoppedBody, revision: restored.body.revision })).status).toBe(403);
  });
});
