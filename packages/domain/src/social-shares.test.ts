import { describe, expect, it } from 'vitest';
import { adminSocialSharesResponseSchema, buildRaceSocialShare, buildWin5SocialShare } from './social-shares';

const prohibited = /買い目|組み合わせ|購入|払戻|回収率|収支|利益|的中/;

describe('SNS共有文', () => {
  it('WIN5全選出を馬の評価事実として表現する', () => {
    const value = buildWin5SocialShare({ targetDate: '2026-09-20', status: 'WIN5_ALL_WINNERS_RECOMMENDED', recommendedLegs: 5 });
    expect(value).toMatchObject({ shareable: true, headline: 'WIN5対象5レース 勝ち馬をすべて候補内に選出' });
    expect(value.text).not.toMatch(prohibited);
  });

  it('通常レースの確認済み結果だけを簡潔に表現する', () => {
    const value = buildRaceSocialShare({ venue: '東京', raceNumber: 10, raceName: '架空特別', status: 'PRIMARY_WIN' });
    expect(value.resultLines).toEqual(['東京10R 架空特別', '本命馬が1着']);
    expect(value.text).not.toMatch(prohibited);
  });

  it('要確認や中止の結果は共有不可にする', () => {
    expect(buildWin5SocialShare({ targetDate: '2026-09-20', status: 'REVIEW_REQUIRED', recommendedLegs: 4 }).shareable).toBe(false);
    expect(buildRaceSocialShare({ venue: '東京', raceNumber: 10, raceName: '架空特別', status: 'CANCELED' }).shareable).toBe(false);
  });
});

describe('SNS共有候補の管理API Contract', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const shareable = {
    id,
    kind: 'PADDOCK' as const,
    targetDate: '2026-09-29',
    title: '東京10R 架空特別',
    status: 'PRIMARY_WIN' as const,
    resultVersion: 2,
    predictionVersion: 1,
    publishedAt: new Date('2026-09-29T05:00:00.000Z'),
    confirmedAt: new Date('2026-09-29T06:00:00.000Z'),
    path: `/races/${id}`,
    shareable: true,
    headline: '東京10R 架空特別 本命馬が1着',
    text: '公開したパドック直前予想。',
    resultLines: ['東京10R 架空特別', '本命馬が1着'],
    blockedReason: null
  };
  const blocked = {
    ...shareable,
    kind: 'WIN5' as const,
    title: 'WIN5前日紙面',
    status: 'REVIEW_REQUIRED' as const,
    path: `/win5/${id}`,
    shareable: false,
    headline: '2026年9月29日 WIN5評価結果',
    text: null,
    resultLines: [],
    blockedReason: '要確認の対象レースがあるため共有できません。'
  };

  it('現行応答を保持してDB日時をJSON日時へ正規化する', () => {
    const parsed = adminSocialSharesResponseSchema.parse({ items: [shareable, blocked] });
    expect(parsed.items[0]).toMatchObject({ kind: 'PADDOCK', status: 'PRIMARY_WIN', shareable: true });
    expect(parsed.items[1]).toMatchObject({ kind: 'WIN5', status: 'REVIEW_REQUIRED', shareable: false, text: null, resultLines: [] });
    expect(parsed.items[0].publishedAt).toBe('2026-09-29T05:00:00.000Z');
    expect(parsed.items[0].confirmedAt).toBe('2026-09-29T06:00:00.000Z');
  });

  it('内部ID、連絡先、金額、SNS資格情報を拒否する', () => {
    for (const privateField of ['confirmedBy', 'email', 'lineSubject', 'predictionVersionId', 'resultVersionId', 'accessToken', 'payoutYen']) {
      expect(adminSocialSharesResponseSchema.safeParse({ items: [{ ...shareable, [privateField]: 'private' }] }).success).toBe(false);
    }
  });

  it('種別と状態・URLの不一致および共有可否の矛盾を拒否する', () => {
    expect(adminSocialSharesResponseSchema.safeParse({ items: [{ ...shareable, status: 'WIN5_PARTIAL' }] }).success).toBe(false);
    expect(adminSocialSharesResponseSchema.safeParse({ items: [{ ...shareable, path: `/win5/${id}` }] }).success).toBe(false);
    expect(adminSocialSharesResponseSchema.safeParse({ items: [{ ...shareable, shareable: false }] }).success).toBe(false);
  });
});
