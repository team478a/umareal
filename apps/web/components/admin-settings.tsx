'use client';
import { useEffect, useState, type FormEvent } from 'react';

type Settings = {
  revision: number;
  operations: { newRegistrationsEnabled: boolean; emailNotificationsEnabled: boolean; predictionPublicationEnabled: boolean; csvImportEnabled: boolean; lineNotificationsEnabled: boolean; lineLoginEnabled: boolean; newPurchasesEnabled: boolean };
  registrationPauseMessage: string;
  captcha: {
    enabled: boolean; siteKey: string | null; secretConfigured: boolean;
    connectionStatus: 'DISABLED' | 'INCOMPLETE' | 'CONFIGURED_NOT_VERIFIED';
    readiness: { siteKeyStored: boolean; secretStored: boolean; secretReadable: boolean; serverValidationReady: boolean; transport: 'TEST_ONLY' | 'TURNSTILE'; externalConnectionTested: boolean };
  };
  maintenanceMessage: string;
  notificationPolicy: { maxAttempts: number; baseDelaySeconds: number };
  billing: { founderSalesEnabled: boolean; founderPriceYen: number; standardPriceYen: number; dayPassPriceYen: number; founderSalesLimit: number; billingGraceDays: number };
  stripe: {
    source: 'ADMIN' | 'ENVIRONMENT'; liveMode: boolean; secretKeyConfigured: boolean; webhookSecretConfigured: boolean;
    priceFounder: string | null; priceStandard: string | null; priceDayPass: string | null;
    connectionStatus: 'NOT_CONFIGURED' | 'INCOMPLETE' | 'CONFIGURED_NOT_VERIFIED';
    readiness: { credentialsStored: boolean; secretsReadable: boolean; pricesConfigured: boolean; modeConsistent: boolean; billingTransport: 'TEST_ONLY' | 'STRIPE'; externalConnectionTested: boolean };
  };
  mail: {
    source: 'ADMIN' | 'ENVIRONMENT'; apiKeyConfigured: boolean; webhookSecretConfigured: boolean; from: string | null;
    connectionStatus: 'NOT_CONFIGURED' | 'INCOMPLETE' | 'CONFIGURED_NOT_VERIFIED';
    readiness: { credentialsStored: boolean; secretReadable: boolean; webhookSecretStored: boolean; webhookSecretReadable: boolean; senderConfigured: boolean; webhookReceiverReady: boolean; mailTransport: 'TEST_ONLY' | 'RESEND'; externalConnectionTested: boolean };
  };
  line: {
    channelId: string | null; channelSecretConfigured: boolean; channelAccessTokenConfigured: boolean; connectionStatus: 'NOT_CONFIGURED' | 'CONFIGURED_NOT_VERIFIED';
    messagingReadiness: { credentialsStored: boolean; secretsReadable: boolean; applicationUrlReady: boolean; notificationWorkerReady: boolean; webhookSignatureVerifierReady: boolean; outboundTransport: 'TEST_ONLY' | 'LINE'; externalConnectionTested: boolean };
    loginChannelId: string | null; loginChannelSecretConfigured: boolean; loginCallbackUrl: string | null; loginConnectionStatus: 'NOT_CONFIGURED' | 'CONFIGURED_NOT_VERIFIED';
        loginReadiness: { credentialsStored: boolean; secretReadable: boolean; callbackUrlConfigured: boolean; oauthCallbackHandlerReady: boolean; oauthTransport: 'TEST_ONLY' | 'LINE'; externalConnectionTested: boolean };
  };
  updatedAt: string;
};

async function request<T>(method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/v1/admin/settings', { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? '設定を保存できませんでした。');
  return value;
}

export function AdminSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [channelSecret, setChannelSecret] = useState(''); const [channelAccessToken, setChannelAccessToken] = useState('');
  const [clearSecret, setClearSecret] = useState(false); const [clearToken, setClearToken] = useState(false);
  const [loginChannelSecret, setLoginChannelSecret] = useState(''); const [clearLoginSecret, setClearLoginSecret] = useState(false);
  const [stripeSecretKey, setStripeSecretKey] = useState(''); const [stripeWebhookSecret, setStripeWebhookSecret] = useState('');
  const [clearStripeSecretKey, setClearStripeSecretKey] = useState(false); const [clearStripeWebhookSecret, setClearStripeWebhookSecret] = useState(false);
  const [mailApiKey, setMailApiKey] = useState(''); const [clearMailApiKey, setClearMailApiKey] = useState(false);
  const [mailWebhookSecret, setMailWebhookSecret] = useState(''); const [clearMailWebhookSecret, setClearMailWebhookSecret] = useState(false);
  const [turnstileSecret, setTurnstileSecret] = useState(''); const [clearTurnstileSecret, setClearTurnstileSecret] = useState(false);
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { request<Settings>().then(setSettings).catch(error => setError(error.message)); }, []);
  function operation(key: keyof Settings['operations'], value: boolean) { setSettings(current => current ? { ...current, operations: { ...current.operations, [key]: value } } : current); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings) return; setBusy(true); setError(''); setMessage('');
    try {
      const updated = await request<Settings>('PATCH', {
        revision: settings.revision, reason, operations: settings.operations, registrationPauseMessage: settings.registrationPauseMessage, maintenanceMessage: settings.maintenanceMessage,
        notificationPolicy: settings.notificationPolicy, billing: settings.billing,
        captcha: { enabled: settings.captcha.enabled, siteKey: settings.captcha.siteKey || null, ...(turnstileSecret ? { secret: turnstileSecret } : {}), clearSecret: clearTurnstileSecret },
        stripe: {
          liveMode: settings.stripe.liveMode, ...(stripeSecretKey ? { secretKey: stripeSecretKey } : {}), ...(stripeWebhookSecret ? { webhookSecret: stripeWebhookSecret } : {}),
          clearSecretKey: clearStripeSecretKey, clearWebhookSecret: clearStripeWebhookSecret,
          priceFounder: settings.stripe.priceFounder || null, priceStandard: settings.stripe.priceStandard || null, priceDayPass: settings.stripe.priceDayPass || null
        },
        mail: { ...(mailApiKey ? { apiKey: mailApiKey } : {}), ...(mailWebhookSecret ? { webhookSecret: mailWebhookSecret } : {}), from: settings.mail.from || null, clearApiKey: clearMailApiKey, clearWebhookSecret: clearMailWebhookSecret },
        line: {
          channelId: settings.line.channelId || null, ...(channelSecret ? { channelSecret } : {}), ...(channelAccessToken ? { channelAccessToken } : {}), clearChannelSecret: clearSecret, clearChannelAccessToken: clearToken,
          loginChannelId: settings.line.loginChannelId || null, ...(loginChannelSecret ? { loginChannelSecret } : {}), loginCallbackUrl: settings.line.loginCallbackUrl || null, clearLoginChannelSecret: clearLoginSecret
        }
      });
      setSettings(updated); setChannelSecret(''); setChannelAccessToken(''); setLoginChannelSecret(''); setStripeSecretKey(''); setStripeWebhookSecret(''); setMailApiKey(''); setMailWebhookSecret(''); setTurnstileSecret(''); setClearSecret(false); setClearToken(false); setClearLoginSecret(false); setClearStripeSecretKey(false); setClearStripeWebhookSecret(false); setClearMailApiKey(false); setClearMailWebhookSecret(false); setClearTurnstileSecret(false); setReason(''); setMessage('管理設定を保存しました。');
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  if (!settings) return <><div className="page-heading"><span className="eyebrow">ADMINISTRATION</span><h1>運用・連携設定</h1></div><p role={error ? 'alert' : 'status'}>{error || '読み込み中…'}</p></>;
  return <><div className="page-heading"><span className="eyebrow">ADMINISTRATION</span><h1>運用・連携設定</h1><p>公開、取込、通知と外部連携の安全な運用状態を管理します。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <form onSubmit={save} className="settings-stack">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">EMERGENCY CONTROLS</span><h2>機能の停止・再開</h2></div><span className="status-tag">設定版 {settings.revision}</span></div><div className="panel-body">
        {([
          ['newRegistrationsEnabled', '新規会員登録', '停止中も既存会員のログインとメール確認は利用できます。'],
          ['emailNotificationsEnabled', 'メール通知', '確認済みメール会員へのレース告知と公開通知を停止・再開します。'],
          ['predictionPublicationEnabled', '予想公開', '停止中は公開前確認と公開確定を拒否します。'],
          ['csvImportEnabled', 'CSV取込', '停止中はプレビューと確定を拒否します。'],
          ['lineNotificationsEnabled', 'LINE通知', '資格情報が揃っている場合だけ有効化できます。'],
          ['lineLoginEnabled', 'LINEログイン', 'ログイン資格情報とCallback URLが揃っている場合だけ有効化できます。'],
          ['newPurchasesEnabled', '新規購入', '停止中はすべての新しい申込を拒否します。']
        ] as const).map(([key, label, description]) => <label className="setting-row" key={key}><span><strong>{label}</strong><small>{description}</small></span><input aria-label={`${label}を有効にする`} type="checkbox" checked={settings.operations[key]} onChange={event => operation(key, event.target.checked)} /></label>)}
        <label className="field settings-message">登録停止中の会員向け案内<textarea aria-label="登録停止中の会員向け案内" rows={3} maxLength={500} required={!settings.operations.newRegistrationsEnabled} value={settings.registrationPauseMessage} onChange={event => setSettings({ ...settings, registrationPauseMessage: event.target.value })} /><small>新規登録を停止する場合は必須です。登録画面を開いた方へそのまま表示します。</small></label>
        <label className="field settings-message">運用メッセージ<textarea aria-label="運用メッセージ" rows={3} maxLength={500} value={settings.maintenanceMessage} onChange={event => setSettings({ ...settings, maintenanceMessage: event.target.value })} /><small>将来の会員向け告知欄に表示する文面です。現在は保存のみ行います。</small></label>
      </div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">REGISTRATION PROTECTION</span><h2>無料登録のBot対策</h2></div><span className={`status-tag ${settings.captcha.connectionStatus === 'CONFIGURED_NOT_VERIFIED' ? '' : 'warning'}`}>{settings.captcha.connectionStatus === 'CONFIGURED_NOT_VERIFIED' ? '設定済み・未疎通' : settings.captcha.connectionStatus === 'INCOMPLETE' ? '設定不足' : '無効'}</span></div><div className="panel-body">
        <div className="notice">Cloudflare Turnstileでメール会員登録を保護します。Secret keyは暗号化し、保存後は画面、API、操作履歴へ返しません。LINE登録には適用しません。</div>
        <div className="readiness-grid" aria-label="無料登録Bot対策の準備"><span className={settings.captcha.readiness.siteKeyStored ? 'ready' : ''}>Site key</span><span className={settings.captcha.readiness.secretStored ? 'ready' : ''}>Secret key</span><span className={settings.captcha.readiness.secretReadable ? 'ready' : ''}>Secret復号</span><span className={settings.captcha.readiness.serverValidationReady ? 'ready' : ''}>サーバー検証</span><span className={settings.captcha.readiness.transport === 'TURNSTILE' ? 'ready' : ''}>{settings.captcha.readiness.transport === 'TURNSTILE' ? 'Turnstile transport' : 'ローカル試験transport'}</span><span>外部疎通は未実施</span></div>
        <label className="setting-row"><span><strong>メール会員登録のBot対策</strong><small>Site keyとSecret keyが揃っている場合だけ有効化できます。</small></span><input aria-label="メール会員登録のBot対策を有効にする" type="checkbox" checked={settings.captcha.enabled} onChange={event => setSettings({ ...settings, captcha: { ...settings.captcha, enabled: event.target.checked } })} /></label>
        <div className="two-columns"><label className="field">Turnstile Site key<input aria-label="Turnstile Site key" maxLength={100} value={settings.captcha.siteKey ?? ''} onChange={event => setSettings({ ...settings, captcha: { ...settings.captcha, siteKey: event.target.value || null } })} placeholder="0x4AAAA…" /></label><label className="field">Turnstile Secret key<input aria-label="Turnstile Secret key" type="password" autoComplete="new-password" maxLength={256} value={turnstileSecret} onChange={event => { setTurnstileSecret(event.target.value); setClearTurnstileSecret(false); }} placeholder={settings.captcha.secretConfigured ? '保存済み（変更時のみ入力）' : '0x4AAAA…'} /></label></div>
        <div className="credential-actions"><label><input type="checkbox" checked={clearTurnstileSecret} onChange={event => { setClearTurnstileSecret(event.target.checked); if (event.target.checked) setTurnstileSecret(''); }} />保存済みSecret keyを削除</label></div>
      </div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">BILLING</span><h2>料金・契約設定</h2></div><span className="status-tag warning">開発初期値</span></div><div className="panel-body">
        <div className="notice">正式な販売条件ではありません。価格、創設会員枠、支払猶予は本番開始前に確定してください。</div>
        <label className="setting-row"><span><strong>創設会員プランを販売</strong><small>全体の新規購入が有効で、販売枠に空きがある場合だけ申込できます。</small></span><input aria-label="創設会員プランを販売" type="checkbox" checked={settings.billing.founderSalesEnabled} onChange={event => setSettings({ ...settings, billing: { ...settings.billing, founderSalesEnabled: event.target.checked } })} /></label>
        <div className="race-form-grid">{([
          ['founderPriceYen', '創設会員 月額（税込）', 0, 1000000], ['standardPriceYen', '通常会員 月額（税込）', 0, 1000000], ['dayPassPriceYen', '1日利用（税込）', 0, 1000000], ['founderSalesLimit', '創設会員の販売上限', 1, 100000], ['billingGraceDays', '支払失敗後の猶予日数', 0, 30]
        ] as const).map(([key, label, min, max]) => <label className="field" key={key}>{label}<input aria-label={label} type="number" min={min} max={max} value={settings.billing[key]} onChange={event => setSettings({ ...settings, billing: { ...settings.billing, [key]: Number(event.target.value) } })} /></label>)}</div>
      </div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">STRIPE</span><h2>Stripe決済連携</h2></div><span className={`status-tag ${settings.stripe.connectionStatus === 'CONFIGURED_NOT_VERIFIED' ? '' : 'warning'}`}>{settings.stripe.connectionStatus === 'CONFIGURED_NOT_VERIFIED' ? '設定済み・未疎通' : settings.stripe.connectionStatus === 'INCOMPLETE' ? '設定不足' : '未設定'}</span></div><div className="panel-body">
        <div className="notice">Secret keyとWebhook secretは暗号化して保存し、保存後は画面やAPIへ返しません。現在の設定元は{settings.stripe.source === 'ADMIN' ? '管理画面' : '環境変数'}です。環境変数から移行する場合は5項目をまとめて入力してください。</div>
        <div className="readiness-grid" aria-label="Stripe接続準備"><span className={settings.stripe.readiness.credentialsStored ? 'ready' : ''}>資格情報の保存</span><span className={settings.stripe.readiness.secretsReadable ? 'ready' : ''}>暗号化データの検証</span><span className={settings.stripe.readiness.pricesConfigured ? 'ready' : ''}>Price ID</span><span className={settings.stripe.readiness.modeConsistent ? 'ready' : ''}>モード整合</span><span className={settings.stripe.readiness.billingTransport === 'STRIPE' ? 'ready' : ''}>{settings.stripe.readiness.billingTransport === 'STRIPE' ? 'Stripe transport' : 'テストtransport'}</span><span>外部疎通は未実施</span></div>
        <label className="setting-row"><span><strong>Stripe本番モード</strong><small>ライブSecret keyと本番Webhookを使う場合だけ有効にします。配備環境側の安全スイッチも必要です。</small></span><input aria-label="Stripe本番モードを有効にする" type="checkbox" checked={settings.stripe.liveMode} onChange={event => setSettings({ ...settings, stripe: { ...settings.stripe, liveMode: event.target.checked } })} /></label>
        <div className="two-columns"><label className="field">Secret key<input aria-label="Stripe Secret key" type="password" autoComplete="new-password" value={stripeSecretKey} onChange={event => { setStripeSecretKey(event.target.value); setClearStripeSecretKey(false); }} placeholder={settings.stripe.secretKeyConfigured ? '保存済み（変更時のみ入力）' : 'sk_test_…'} /></label><label className="field">Webhook secret<input aria-label="Stripe Webhook secret" type="password" autoComplete="new-password" value={stripeWebhookSecret} onChange={event => { setStripeWebhookSecret(event.target.value); setClearStripeWebhookSecret(false); }} placeholder={settings.stripe.webhookSecretConfigured ? '保存済み（変更時のみ入力）' : 'whsec_…'} /></label></div>
        <div className="race-form-grid"><label className="field">創設会員 Price ID<input aria-label="Stripe 創設会員 Price ID" value={settings.stripe.priceFounder ?? ''} maxLength={100} onChange={event => setSettings({ ...settings, stripe: { ...settings.stripe, priceFounder: event.target.value || null } })} placeholder="price_…" /></label><label className="field">通常会員 Price ID<input aria-label="Stripe 通常会員 Price ID" value={settings.stripe.priceStandard ?? ''} maxLength={100} onChange={event => setSettings({ ...settings, stripe: { ...settings.stripe, priceStandard: event.target.value || null } })} placeholder="price_…" /></label><label className="field">1日利用 Price ID<input aria-label="Stripe 1日利用 Price ID" value={settings.stripe.priceDayPass ?? ''} maxLength={100} onChange={event => setSettings({ ...settings, stripe: { ...settings.stripe, priceDayPass: event.target.value || null } })} placeholder="price_…" /></label></div>
        <div className="credential-actions"><label><input type="checkbox" checked={clearStripeSecretKey} onChange={event => { setClearStripeSecretKey(event.target.checked); if (event.target.checked) setStripeSecretKey(''); }} />保存済みSecret keyを削除</label><label><input type="checkbox" checked={clearStripeWebhookSecret} onChange={event => { setClearStripeWebhookSecret(event.target.checked); if (event.target.checked) setStripeWebhookSecret(''); }} />保存済みWebhook secretを削除</label></div>
      </div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">EMAIL DELIVERY</span><h2>メール配信連携</h2></div><span className={`status-tag ${settings.mail.connectionStatus === 'CONFIGURED_NOT_VERIFIED' ? '' : 'warning'}`}>{settings.mail.connectionStatus === 'CONFIGURED_NOT_VERIFIED' ? '設定済み・未疎通' : settings.mail.connectionStatus === 'INCOMPLETE' ? '設定不足' : '未設定'}</span></div><div className="panel-body">
        <div className="notice">Resend API keyとWebhook signing secretは暗号化して保存し、保存後は画面やAPIへ返しません。現在の設定元は{settings.mail.source === 'ADMIN' ? '管理画面' : '環境変数'}です。管理画面へ移行する場合は3項目をまとめて入力してください。</div>
        <div className="readiness-grid" aria-label="メール配信接続準備"><span className={settings.mail.readiness.credentialsStored ? 'ready' : ''}>API keyの保存</span><span className={settings.mail.readiness.secretReadable ? 'ready' : ''}>API keyの復号</span><span className={settings.mail.readiness.webhookSecretStored && settings.mail.readiness.webhookSecretReadable ? 'ready' : ''}>Webhook署名鍵</span><span className={settings.mail.readiness.senderConfigured ? 'ready' : ''}>送信元</span><span className={settings.mail.readiness.webhookReceiverReady ? 'ready' : ''}>Webhook受信処理</span><span className={settings.mail.readiness.mailTransport === 'RESEND' ? 'ready' : ''}>{settings.mail.readiness.mailTransport === 'RESEND' ? 'Resend transport' : 'テストtransport'}</span><span>外部疎通は未実施</span></div>
        <div className="two-columns"><label className="field">Resend API key<input aria-label="Resend API key" type="password" autoComplete="new-password" value={mailApiKey} onChange={event => { setMailApiKey(event.target.value); setClearMailApiKey(false); }} placeholder={settings.mail.apiKeyConfigured ? '保存済み（変更時のみ入力）' : 're_…'} /></label><label className="field">Webhook signing secret<input aria-label="Resend Webhook signing secret" type="password" autoComplete="new-password" value={mailWebhookSecret} onChange={event => { setMailWebhookSecret(event.target.value); setClearMailWebhookSecret(false); }} placeholder={settings.mail.webhookSecretConfigured ? '保存済み（変更時のみ入力）' : 'whsec_…'} /></label></div><label className="field">送信元<input aria-label="メール送信元" value={settings.mail.from ?? ''} maxLength={320} onChange={event => setSettings({ ...settings, mail: { ...settings.mail, from: event.target.value || null } })} placeholder="競馬会員メディア <notice@example.com>" /></label>
        <div className="credential-actions"><label><input type="checkbox" checked={clearMailApiKey} onChange={event => { setClearMailApiKey(event.target.checked); if (event.target.checked) setMailApiKey(''); }} />保存済みResend API keyを削除</label><label><input type="checkbox" checked={clearMailWebhookSecret} onChange={event => { setClearMailWebhookSecret(event.target.checked); if (event.target.checked) setMailWebhookSecret(''); }} />保存済みWebhook signing secretを削除</label></div>
      </div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">LINE MESSAGING API</span><h2>LINE連携</h2></div><span className={`status-tag ${settings.line.connectionStatus === 'NOT_CONFIGURED' ? 'warning' : ''}`}>{settings.line.connectionStatus === 'NOT_CONFIGURED' ? '未設定' : '設定済み・未疎通'}</span></div><div className="panel-body">
        <div className="notice">Channel secretとChannel access tokenは暗号化して保存し、保存後は画面やAPIへ返しません。</div>
        <div className="readiness-grid" aria-label="LINE Messaging API接続準備"><span className={settings.line.messagingReadiness.credentialsStored ? 'ready' : ''}>資格情報の保存</span><span className={settings.line.messagingReadiness.secretsReadable ? 'ready' : ''}>暗号化データの検証</span><span className={settings.line.messagingReadiness.applicationUrlReady ? 'ready' : ''}>会員ページURL</span><span className={settings.line.messagingReadiness.notificationWorkerReady ? 'ready' : ''}>通知ワーカー</span><span className={settings.line.messagingReadiness.webhookSignatureVerifierReady ? 'ready' : ''}>Webhook署名検証</span><span>外部疎通は未実施</span></div>
        <label className="field">Channel ID<input aria-label="LINE Channel ID" value={settings.line.channelId ?? ''} maxLength={100} onChange={event => setSettings({ ...settings, line: { ...settings.line, channelId: event.target.value || null } })} /></label>
        <div className="two-columns"><label className="field">Channel secret<input aria-label="LINE Channel secret" type="password" autoComplete="new-password" value={channelSecret} onChange={event => { setChannelSecret(event.target.value); setClearSecret(false); }} placeholder={settings.line.channelSecretConfigured ? '保存済み（変更時のみ入力）' : '未設定'} /></label><label className="field">Channel access token<input aria-label="LINE Channel access token" type="password" autoComplete="new-password" value={channelAccessToken} onChange={event => { setChannelAccessToken(event.target.value); setClearToken(false); }} placeholder={settings.line.channelAccessTokenConfigured ? '保存済み（変更時のみ入力）' : '未設定'} /></label></div>
        <div className="credential-actions"><label><input type="checkbox" checked={clearSecret} onChange={event => { setClearSecret(event.target.checked); if (event.target.checked) setChannelSecret(''); }} />保存済みChannel secretを削除</label><label><input type="checkbox" checked={clearToken} onChange={event => { setClearToken(event.target.checked); if (event.target.checked) setChannelAccessToken(''); }} />保存済みaccess tokenを削除</label></div>
      </div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">LINE LOGIN</span><h2>会員LINEログイン連携</h2></div><span className={`status-tag ${settings.line.loginConnectionStatus === 'NOT_CONFIGURED' ? 'warning' : ''}`}>{settings.line.loginConnectionStatus === 'NOT_CONFIGURED' ? '未設定' : '設定済み・未疎通'}</span></div><div className="panel-body">
        <div className="notice">LINE Login用のChannel secretも暗号化し、保存後は再表示しません。Messaging APIとは別のチャネル設定として管理します。</div>
        <div className="readiness-grid" aria-label="LINE Login接続準備"><span className={settings.line.loginReadiness.credentialsStored ? 'ready' : ''}>資格情報の保存</span><span className={settings.line.loginReadiness.secretReadable ? 'ready' : ''}>暗号化データの検証</span><span className={settings.line.loginReadiness.callbackUrlConfigured ? 'ready' : ''}>Callback URL</span><span className={settings.line.loginReadiness.oauthCallbackHandlerReady ? 'ready' : ''}>OAuth Callback</span><span className={settings.line.loginReadiness.oauthTransport === 'LINE' ? 'ready' : ''}>{settings.line.loginReadiness.oauthTransport === 'LINE' ? 'LINE transport' : 'テストtransport'}</span><span>外部疎通は未実施</span></div>
        <div className="two-columns"><label className="field">Login Channel ID<input aria-label="LINE Login Channel ID" value={settings.line.loginChannelId ?? ''} maxLength={100} onChange={event => setSettings({ ...settings, line: { ...settings.line, loginChannelId: event.target.value || null } })} /></label><label className="field">Login Channel secret<input aria-label="LINE Login Channel secret" type="password" autoComplete="new-password" value={loginChannelSecret} onChange={event => { setLoginChannelSecret(event.target.value); setClearLoginSecret(false); }} placeholder={settings.line.loginChannelSecretConfigured ? '保存済み（変更時のみ入力）' : '未設定'} /></label></div>
        <label className="field">Callback URL<input aria-label="LINE Login Callback URL" type="url" value={settings.line.loginCallbackUrl ?? ''} maxLength={500} onChange={event => setSettings({ ...settings, line: { ...settings.line, loginCallbackUrl: event.target.value || null } })} placeholder="https://example.com/api/v1/auth/line/callback" /></label>
        <div className="credential-actions"><label><input type="checkbox" checked={clearLoginSecret} onChange={event => { setClearLoginSecret(event.target.checked); if (event.target.checked) setLoginChannelSecret(''); }} />保存済みLogin Channel secretを削除</label></div>
      </div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DELIVERY POLICY</span><h2>通知再試行</h2></div></div><div className="panel-body"><div className="two-columns"><label className="field">最大試行回数<input aria-label="通知の最大試行回数" type="number" min={1} max={10} value={settings.notificationPolicy.maxAttempts} onChange={event => setSettings({ ...settings, notificationPolicy: { ...settings.notificationPolicy, maxAttempts: Number(event.target.value) } })} /></label><label className="field">初回待機秒数<input aria-label="通知の初回待機秒数" type="number" min={10} max={3600} value={settings.notificationPolicy.baseDelaySeconds} onChange={event => setSettings({ ...settings, notificationPolicy: { ...settings.notificationPolicy, baseDelaySeconds: Number(event.target.value) } })} /></label></div></div></section>
      <section className="panel"><div className="panel-body"><label className="field">変更理由<input aria-label="管理設定の変更理由" required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label><p className="muted form-note">保存内容、実行者、日時、理由を操作履歴へ記録します。資格情報そのものは記録しません。</p><button className="button" disabled={busy || !reason.trim()}>{busy ? '保存中…' : '管理設定を保存'}</button></div></section>
    </form>
  </>;
}
