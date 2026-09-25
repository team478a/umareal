import { describe, expect, it } from 'vitest';
import { buildBillingLineMessage, buildPredictionLineMessage, buildRaceResultLineMessage, buildSupportReplyLineMessage, buildWin5LineMessage, buildWin5ResultLineMessage } from './line';

const base = { eventType: 'PREDICTION_PUBLISHED' as const, raceId: '38bbc51a-2aa4-4b43-8661-c3c6164e2f64', raceDate: '2026-09-12', venue: '東京', raceNumber: 11, raceName: 'テストステークス', version: 1, visibility: 'PAID' as const, appBaseUrl: 'https://members.example.jp' };
describe('LINE notification message preparation', () => {
  it('builds a support reply notice without inquiry content', () => {
    const message = buildSupportReplyLineMessage({ eventType: 'SUPPORT_RESPONSE_POSTED', requestId: 'e06ec166-69c9-4119-bdd4-0fe2b4cf6228', appBaseUrl: 'https://members.example.jp' });
    expect(message.text).toContain('お問い合わせへの回答があります');
    expect(message.text).toContain('https://members.example.jp/support');
  });
  it('builds a metadata-only member-page notice', () => {
    const message = buildPredictionLineMessage(base);
    expect(message.type).toBe('text');
    expect(message.text).toContain('最終予想を公開しました');
    expect(message.text).toContain('第1版・有料会員向け');
    expect(message.text).toContain('https://members.example.jp/');
    expect(message.text).not.toMatch(/本命|買い目|馬番|円/);
  });
  it('labels corrections and removes injected newlines from race metadata', () => {
    const message = buildPredictionLineMessage({ ...base, eventType: 'PREDICTION_CORRECTED', raceName: '訂正\nレース', version: 2 });
    expect(message.text).toContain('最終予想を訂正しました');
    expect(message.text).toContain('訂正 レース');
  });
  it('builds a race announcement without prediction details', () => {
    const message = buildPredictionLineMessage({ ...base, eventType: 'RACE_ANNOUNCED' });
    expect(message.text).toContain('予想対象レースのお知らせ');
    expect(message.text).toContain(`/races/${base.raceId}`);
    expect(message.text).not.toMatch(/本命|買い目|馬番|円/);
  });

  it('builds free report notices without horse or betting details', () => {
    const message = buildPredictionLineMessage({ ...base, eventType: 'FREE_REPORT_PUBLISHED', visibility: 'FREE' });
    expect(message.text).toContain('無料パドック速報を公開しました');
    expect(message.text).not.toMatch(/本命|買い目|馬番|円/);
  });
  it('rejects insecure non-local links', () => {
    expect(() => buildPredictionLineMessage({ ...base, appBaseUrl: 'http://members.example.jp' })).toThrow('HTTPS');
    expect(() => buildPredictionLineMessage({ ...base, appBaseUrl: 'http://127.0.0.1:3000' })).not.toThrow();
  });
});

describe('WIN5 LINE notification message preparation', () => {
  const input = { eventType: 'WIN5_PREVIEW_PUBLISHED' as const, productId: '38bbc51a-2aa4-4b43-8661-c3c6164e2f64', targetDate: '2026-09-13', title: '日曜WIN5\n紙面', version: 1, appBaseUrl: 'https://members.example.jp' };

  it('builds a safe member-page notice without paper selections or amounts', () => {
    const message = buildWin5LineMessage(input);
    expect(message.text).toContain('WIN5紙面予想を公開しました');
    expect(message.text).toContain('日曜WIN5 紙面');
    expect(message.text).toContain(`/win5/${input.productId}`);
    expect(message.text).not.toMatch(/中心馬|選択馬|馬番|買い目|円/);
  });

  it('labels a correction version', () => {
    const message = buildWin5LineMessage({ ...input, eventType: 'WIN5_PREVIEW_CORRECTED', version: 2 });
    expect(message.text).toContain('WIN5紙面予想を訂正しました');
    expect(message.text).toContain('第2版');
  });
});

describe('evaluation result notification message preparation', () => {
  it('describes a confirmed race evaluation without restricted details', () => {
    const message = buildRaceResultLineMessage({ eventType: 'RACE_EVALUATION_CONFIRMED', raceId: base.raceId, raceDate: base.raceDate, venue: base.venue, raceNumber: base.raceNumber, raceName: base.raceName, resultVersion: 2, status: 'PRIMARY_WIN', appBaseUrl: base.appBaseUrl });
    expect(message.text).toContain('本命馬が1着');
    expect(message.text).toContain(`/races/${base.raceId}`);
    expect(message.text).not.toMatch(/買い目|組み合わせ|購入|払戻|回収率|収支|利益|的中|馬番/);
  });

  it('describes WIN5 candidate coverage as a separate fact', () => {
    const message = buildWin5ResultLineMessage({ eventType: 'WIN5_EVALUATION_CONFIRMED', productId: base.raceId, targetDate: base.raceDate, title: 'WIN5紙面', resultVersion: 1, status: 'WIN5_ALL_WINNERS_RECOMMENDED', recommendedLegs: 5, appBaseUrl: base.appBaseUrl });
    expect(message.text).toContain('対象5レースすべてで勝ち馬を候補内に選出');
    expect(message.text).not.toMatch(/買い目|組み合わせ|購入|払戻|回収率|収支|利益|的中|馬番/);
  });
});

describe('billing notification message preparation', () => {
  it.each([
    ['PAYMENT_SUCCEEDED', 'お支払いを確認しました'],
    ['PAYMENT_FAILED', 'お支払いを確認できませんでした'],
    ['PAYMENT_RECOVERED', 'お支払い状態が回復しました'],
    ['CANCELLATION_SCHEDULED', '解約予約を受け付けました'],
    ['SUBSCRIPTION_ENDED', '月額契約が終了しました']
  ] as const)('builds a safe %s member notice', (eventType, heading) => {
    const message = buildBillingLineMessage({ eventType, planCode: 'STANDARD', currentPeriodEndsAt: new Date('2026-10-17T00:00:00Z'), appBaseUrl: base.appBaseUrl });
    expect(message.text).toContain(heading);
    expect(message.text).toContain('/account');
    expect(message.text).not.toMatch(/card|token|secret|provider/i);
  });

  it('builds a safe one-day-pass refund notice', () => {
    const message = buildBillingLineMessage({ eventType: 'REFUND_COMPLETED', planCode: 'DAY_PASS', currentPeriodEndsAt: new Date('2026-10-17T00:00:00Z'), appBaseUrl: base.appBaseUrl });
    expect(message.text).toContain('返金手続きが完了しました');
    expect(message.text).toContain('1日利用');
    expect(message.text).toContain('/account');
  });
});
