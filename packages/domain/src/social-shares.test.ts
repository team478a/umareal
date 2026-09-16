import { describe, expect, it } from 'vitest';
import { buildRaceSocialShare, buildWin5SocialShare } from './social-shares';

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
