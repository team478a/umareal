import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRacePaperNotice, parseRacePaper, racePaperDraftSchema, racePaperReadSchema } from './race-paper';

const source = `明日の紙面予想です。
宜しくお願いいたします。
東京
9R\u3000八ヶ岳特別
◎４・フィールドノート
○７・ミッキージャンプ
▲８・ドッグウッド
△２・イージーライダー
△11・ホウオウシンデレラ
10R\u3000白秋ステークス
◎５・レッドキングリー
○３・ホウオウシェリー
▲17・シャイフ
△９・トライアンフパス
✕７・チャンネルトンネル
11R\u3000グリーンチャンネルC
◎４・ヘニーガイスト
○１・ルヴァレドクール
▲３・スナッピードレッサ
△５・ドンエレクトス
✕11・ジャスティンアース
京都
10R\u3000大山崎ステークス
◎６・ウルスクローム
○14・ルクスデイジー
▲３・ハヤテノツバサ
△11・レーオーグレーザー
✕５・ライジン
11R\u3000オパールステークス
◎10・ヒシアイラ
○18・ディアナザール
▲８・レッドエヴァンス
△４・メイショウヨゾラ
✕15・タガノアラリア`;

describe('regular race paper transcription', () => {
  it('preserves every supplied race and symbol, including repeated triangles and recommendation crosses', () => {
    const parsed = parseRacePaper(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.races.map(r => `${r.venue}${r.number}`)).toEqual(['東京9', '東京10', '東京11', '京都10', '京都11']);
    expect(parsed.races.flatMap(r => r.marks)).toHaveLength(25);
    expect(parsed.races[0].marks).toEqual([
      { symbol: '◎', number: 4, horseName: 'フィールドノート' },
      { symbol: '○', number: 7, horseName: 'ミッキージャンプ' },
      { symbol: '▲', number: 8, horseName: 'ドッグウッド' },
      { symbol: '△', number: 2, horseName: 'イージーライダー' },
      { symbol: '△', number: 11, horseName: 'ホウオウシンデレラ' }
    ]);
    expect(parsed.races[1].marks[4]).toEqual({ symbol: '✕', number: 7, horseName: 'チャンネルトンネル' });
    expect(parsed.races[4].marks[4]).toEqual({ symbol: '✕', number: 15, horseName: 'タガノアラリア' });
  });
  it.each([
    '東京\n9R 試験\n◎1・馬\n○1・同じ馬',
    '東京\n9R 試験\n◎1・馬\n◎2・馬2',
    '東京\n9R 試験\n○1・馬',
    '東京\n9R 試験\n◎19・馬',
    '9R 試験\n◎1・馬',
    '東京\n13R 試験\n◎1・馬',
    '東京\n9R 試験\n◎1・馬\n東京\n9R 試験\n◎2・馬2',
    '東京\n9R 試験\n◎1・馬\n買い目 1-2',
    '東京\n9R 試験\n◎1・馬\n勝手に読み飛ばせない本文'
  ])('rejects ambiguous or unrecognized input: %s', text => {
    expect(parseRacePaper(text).errors.length).toBeGreaterThan(0);
  });
  it('normalizes common circle and cross glyphs without changing their meaning', () => {
    expect(parseRacePaper('東京\n９Ｒ 試験\n◎１・馬\n◯２・馬2\n×３・馬3').races[0].marks.map(m => m.symbol)).toEqual(['◎', '○', '✕']);
  });
  it('rejects duplicate race and horse ids in direct API drafts', () => {
    const race = { raceId: randomUUID(), marks: [{ entryId: randomUUID(), symbol: '◎', reason: '' }] };
    const draft = { targetDate: '2099-01-01', title: '紙面', summary: '', accessScope: 'MEMBERS', races: [race] };
    expect(racePaperDraftSchema.safeParse(draft).success).toBe(true);
    expect(racePaperDraftSchema.safeParse({ ...draft, races: [race, race] }).success).toBe(false);
    expect(racePaperDraftSchema.safeParse({ ...draft, races: [{ ...race, marks: [...race.marks, { ...race.marks[0], symbol: '△' }] }] }).success).toBe(false);
  });
  it('builds a metadata-only notice with a safe member-page link', () => {
    const id = randomUUID();
    const message = buildRacePaperNotice({ id, title: '前日紙面', targetDate: '2099-01-01', version: 2, appBaseUrl: 'https://app.umareal.com' });
    expect(message.text).toContain(`https://app.umareal.com/papers/${id}`);
    expect(message.text).toContain('訂正版');
    expect(message.text).not.toMatch(/[◎○▲△✕]|フィールドノート|token|購入金額/);
    expect(() => buildRacePaperNotice({ id: '../admin', title: '紙面', targetDate: '2099-01-01', version: 1, appBaseUrl: 'https://app.umareal.com' })).toThrow();
  });
  it('forbids prediction contents in locked API responses', () => {
    const version = { id: randomUUID(), version: 1, targetDate: '2099-01-01', title: '紙面', accessScope: 'PAID', publishedAt: new Date().toISOString(), correctionReason: null, locked: true };
    expect(racePaperReadSchema.safeParse({ id: randomUUID(), versions: [version] }).success).toBe(true);
    expect(racePaperReadSchema.safeParse({ id: randomUUID(), versions: [{ ...version, snapshot: {} }] }).success).toBe(false);
  });
});
