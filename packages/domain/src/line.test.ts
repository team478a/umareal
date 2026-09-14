import { describe, expect, it } from 'vitest';
import { buildPredictionLineMessage } from './line';

const base = { eventType: 'PREDICTION_PUBLISHED' as const, raceId: '38bbc51a-2aa4-4b43-8661-c3c6164e2f64', raceDate: '2026-09-12', venue: '東京', raceNumber: 11, raceName: 'テストステークス', version: 1, visibility: 'PAID' as const, appBaseUrl: 'https://members.example.jp' };
describe('LINE notification message preparation', () => {
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
