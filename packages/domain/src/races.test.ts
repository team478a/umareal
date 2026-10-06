import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { CsvRaceDataProvider, dateSchema, entryHeaders, expertRaceListResponseSchema, parseCsv, parseJraVanRaceBundle, parseQuickRaceList, publicRaceAnnouncementsResponseSchema, publicRaceListQuerySchema, publicRaceListResponseSchema, raceHeaders, raceInputSchema, serializeRaceCsv } from './races';
const provider = new CsvRaceDataProvider();
const race = '2099-01-10,東京,1,"名前,引用",未勝利,1600,TURF,LEFT,2099-01-10T10:00:00+09:00,GOOD,晴,SCHEDULED,';
describe('CSV validation before mutations', () => {
  it('reads BOM, CRLF, escaped quotes, commas and multiline fields', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x,y","a""b\nc"\r\n')).toEqual([['a', 'b'], ['x,y', 'a"b\nc']]);
    const result = provider.parse('races', `${raceHeaders.join(',')}\r\n${race}`);
    expect(result.errors).toEqual([]); expect(result.races[0].name).toBe('名前,引用');
    expect(result.races[0].expertId).toBeNull();
  });
  it('rejects invalid quoting, missing/duplicate columns, empty files and excessive rows', () => {
    expect(() => parseCsv('a\n"unclosed')).toThrow();
    expect(() => parseCsv('a\n"closed"oops')).toThrow();
    expect(() => parseCsv('a\n' + 'x\n'.repeat(201))).toThrow();
    expect(provider.parse('races', 'raceDate,raceDate\na,b').errors.length).toBeGreaterThan(0);
    expect(provider.parse('races', raceHeaders.join(',')).errors.length).toBeGreaterThan(0);
    expect(provider.parse('races', `${raceHeaders.join(',')}\nx,y`).errors[0].row).toBe(2);
  });
  it('rejects duplicate natural keys and formula text with row numbers', () => {
    expect(provider.parse('races', `${raceHeaders.join(',')}\n${race}\n${race}`).errors).toContainEqual(expect.objectContaining({ row: 3, field: 'number' }));
    const unsafe = race.replace('"名前,引用"', '=HYPERLINK("bad")');
    expect(provider.parse('races', `${raceHeaders.join(',')}\n${unsafe}`).errors.length).toBeGreaterThan(0);
    const formula = race.replace('"名前,引用"', '=1+1');
    expect(provider.parse('races', `${raceHeaders.join(',')}\n${formula}`).errors).toContainEqual(expect.objectContaining({ field: 'name' }));
  });
  it('validates calendar dates, JST dates and nonblank required numbers', () => {
    expect(dateSchema.safeParse('2099-02-30').success).toBe(false);
    const valid = provider.parse('races', `${raceHeaders.join(',')}\n${race}`).races[0];
    expect(raceInputSchema.safeParse({ ...valid, startsAt: '2099-01-10T23:00:00Z' }).success).toBe(false);
    expect(raceInputSchema.safeParse({ ...valid, startsAt: 'invalid' }).success).toBe(false);
    expect(provider.parse('races', `${raceHeaders.join(',')}\n${race.replace('2099-01-10T10:00:00+09:00', '')}`).errors).toContainEqual(expect.objectContaining({ field: 'startsAt' }));
    expect(provider.parse('races', `${raceHeaders.join(',')}\n${race.replace(',1600,', ',,')}`).errors.length).toBeGreaterThan(0);
  });
  it('permits unknown odds but rejects duplicate horse IDs and out-of-range entries', () => {
    const entry = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1,1,1,テスト馬,MALE,3,57,騎手,調教師,,,ACTIVE';
    const parsed = provider.parse('entries', `${entryHeaders.join(',')}\n${entry}`);
    expect(parsed.errors).toEqual([]); expect(parsed.entries[0].winOdds).toBeNull();
    expect(provider.parse('entries', `${entryHeaders.join(',')}\n${entry}\n${entry.replace(',1,1,', ',2,1,')}`).errors).toContainEqual(expect.objectContaining({ row: 3, field: 'horseId' }));
    expect(provider.parse('entries', `${entryHeaders.join(',')}\n${entry.replace(',57,', ',200,')}`).errors.length).toBeGreaterThan(0);
  });
  it('turns a readable multi-venue list into validated race CSV', () => {
    const parsed = parseQuickRaceList({
      raceDate: '2099-10-03', raceClass: '特別競走',
      text: '東京\n9R　八ヶ岳特別　14：35　芝1800m　左回り\n10R 白秋ステークス 15:10 芝1400 左\n\n京都競馬場：\n10Ｒ 大山崎ステークス 15:00 ダ1200 右'
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.races).toHaveLength(3);
    expect(parsed.races[0]).toMatchObject({ venue: '東京', number: 9, name: '八ヶ岳特別', raceClass: '特別競走', distance: 1800, surface: 'TURF', direction: 'LEFT', going: 'UNKNOWN', weather: '未確認', status: 'SCHEDULED', expertId: null });
    expect(parsed.races[0]?.startsAt).toBe('2099-10-03T05:35:00.000Z');
    expect(parsed.races[2]).toMatchObject({ venue: '京都', number: 10, surface: 'DIRT', direction: 'RIGHT' });
    const reparsed = provider.parse('races', serializeRaceCsv(parsed.races));
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.races).toEqual(parsed.races);
  });
  it('reports line-specific errors for malformed or duplicate quick registration rows', () => {
    const missingVenue = parseQuickRaceList({ raceDate: '2099-10-03', raceClass: '未設定', text: '9R レース名 14:35 芝1800 左' });
    expect(missingVenue.errors).toContainEqual(expect.objectContaining({ row: 1, field: 'venue' }));
    const malformed = parseQuickRaceList({ raceDate: '2099-10-03', raceClass: '未設定', text: '東京\n9R 情報不足' });
    expect(malformed.errors).toContainEqual(expect.objectContaining({ row: 2, field: 'text' }));
    const duplicate = parseQuickRaceList({ raceDate: '2099-10-03', raceClass: '未設定', text: '東京\n9R 最初 14:35 芝1800 左\n9R 二つ目 15:00 ダ1600 左' });
    expect(duplicate.errors).toContainEqual(expect.objectContaining({ row: 3, field: 'number' }));
    expect(parseQuickRaceList({ raceDate: '2099-02-30', raceClass: '未設定', text: '東京\n9R レース名 14:35 芝1800 左' }).errors).toContainEqual(expect.objectContaining({ field: 'raceDate' }));
  });
  it('accepts the deterministic JRA-VAN race and entry bridge samples', () => {
    const samples = resolve(process.cwd(), 'tools/jra_van_bridge/samples');
    const races = provider.parse('races', readFileSync(resolve(samples, 'expected-jra-van-races.csv'), 'utf8'));
    const entries = provider.parse('entries', readFileSync(resolve(samples, 'expected-jra-van-entries.csv'), 'utf8'));
    expect(races.errors).toEqual([]);
    expect(races.races[0]).toMatchObject({ venue: '東京', number: 10, expertId: null });
    expect(entries.errors).toEqual([]);
    expect(entries.entries[0]).toMatchObject({ number: 6, carriedWeight: 57, winOdds: 3.4 });
  });
  it('verifies a complete JRA-VAN bundle manifest before parsing races and entries', () => {
    const samples = resolve(process.cwd(), 'tools/jra_van_bridge/samples');
    const racesCsv = readFileSync(resolve(samples, 'expected-jra-van-races.csv'), 'utf8');
    const entriesCsv = readFileSync(resolve(samples, 'expected-jra-van-entries.csv'), 'utf8');
    const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
    const entryPath = 'entries/2026-09-13-05-10R.csv';
    const manifest = JSON.stringify({
      formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1', targetDate: '2026-09-13', raceCount: 1, entryRaceCount: 1, entryCount: 1,
      finalizedRaceCount: 0, resultsIncluded: false,
      source: { raRecordCount: 1, raSha256: 'a'.repeat(64), seRecordCount: 1, seSha256: 'b'.repeat(64) },
      files: [
        { kind: 'RACES', path: 'races.csv', rowCount: 1, sha256: checksum(racesCsv) },
        { kind: 'ENTRIES', path: entryPath, rowCount: 1, sha256: checksum(entriesCsv) }
      ]
    });
    const parsed = parseJraVanRaceBundle({ manifest, racesCsv, entries: [{ path: entryPath, csv: entriesCsv }] }, checksum);
    expect(parsed.errors).toEqual([]);
    expect(parsed.races[0]).toMatchObject({ raceDate: '2026-09-13', venue: '東京', number: 10 });
    expect(parsed.entryGroups[0].entries[0]).toMatchObject({ number: 6, horseName: 'テストホース' });
    const tampered = parseJraVanRaceBundle({ manifest, racesCsv, entries: [{ path: entryPath, csv: entriesCsv.replace('テストホース', '改変馬') }] }, checksum);
    expect(tampered.errors).toContainEqual(expect.objectContaining({ field: entryPath, message: expect.stringContaining('SHA-256') }));
    const missing = parseJraVanRaceBundle({ manifest, racesCsv, entries: [] }, checksum);
    expect(missing.errors).toContainEqual(expect.objectContaining({ field: 'entries', message: expect.stringContaining('不足') }));
    const rehearsal = parseJraVanRaceBundle({ manifest: JSON.stringify({ ...JSON.parse(manifest), sampleData: true }), racesCsv, entries: [{ path: entryPath, csv: entriesCsv }] }, checksum);
    expect(rehearsal.errors).toContainEqual(expect.objectContaining({ field: 'manifest.sampleData', message: expect.stringContaining('合成データ') }));
  });
  it('normalizes the public race list without exposing prediction content', () => {
    const raceId = '11111111-1111-4111-8111-111111111111';
    const response = {
      items: [{
        id: raceId, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走',
        startsAt: new Date('2026-09-27T06:00:00.000Z'), status: 'SCHEDULED' as const, raceDayId: null,
        raceClass: 'G1', distance: 2000, surface: 'TURF', direction: 'RIGHT', going: 'GOOD', weather: '晴', revision: 1,
        latestAnnouncement: { version: 1, publishedAt: new Date('2026-09-26T06:00:00.000Z') },
        latestPrediction: { version: 2, status: 'CORRECTED' as const, visibility: 'PAID' as const, publishedAt: new Date('2026-09-27T05:00:00.000Z') },
        latestResult: { version: 1, raceCanceled: false, confirmedAt: new Date('2026-09-27T08:00:00.000Z') }
      }],
      total: 1, page: 1, limit: 20,
      filters: { date: '2026-09-27', dateFrom: '2026-09-27', dateTo: '2026-09-27', publication: 'ALL' as const, result: 'ALL' as const, venue: null, keyword: null, venues: ['中山'] }
    };
    const parsed = publicRaceListResponseSchema.parse(response);
    expect(parsed.items[0]?.startsAt).toBe('2026-09-27T06:00:00.000Z');
    expect(parsed.items[0]?.latestPrediction?.publishedAt).toBe('2026-09-27T05:00:00.000Z');
    expect(parsed.items[0]?.latestResult?.confirmedAt).toBe('2026-09-27T08:00:00.000Z');
    expect(publicRaceListResponseSchema.safeParse({ ...response, items: [{ ...response.items[0], contentSnapshot: { secret: true } }] }).success).toBe(false);
    expect(publicRaceListResponseSchema.safeParse({ ...response, items: [{ ...response.items[0], assignments: [{ userId: raceId }] }] }).success).toBe(false);
  });
  it('limits archive searches to a complete 93-day range', () => {
    expect(publicRaceListQuerySchema.parse({ dateFrom: '2026-07-02', dateTo: '2026-10-02', keyword: '秋華賞' })).toMatchObject({ result: 'ALL', publication: 'ALL' });
    expect(publicRaceListQuerySchema.safeParse({ date: '2026-10-02', dateFrom: '2026-09-01', dateTo: '2026-10-02' }).success).toBe(false);
    expect(publicRaceListQuerySchema.safeParse({ dateFrom: '2026-10-02' }).success).toBe(false);
    expect(publicRaceListQuerySchema.safeParse({ dateFrom: '2026-01-01', dateTo: '2026-10-02' }).success).toBe(false);
  });
  it('normalizes public announcements without exposing internal announcement or race data', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const response = {
      items: [{
        id, version: 2, publishedAt: new Date('2026-09-29T04:00:00.000Z'),
        race: {
          id: '22222222-2222-4222-8222-222222222222', raceDate: '2026-09-29', venue: '中山', number: 11,
          name: 'テスト競走', startsAt: new Date('2026-09-29T06:00:00.000Z')
        }
      }]
    };
    const parsed = publicRaceAnnouncementsResponseSchema.parse(response);
    expect(parsed.items[0]).toMatchObject({ id, version: 2, publishedAt: '2026-09-29T04:00:00.000Z' });
    expect(parsed.items[0]?.race.startsAt).toBe('2026-09-29T06:00:00.000Z');
    expect(publicRaceAnnouncementsResponseSchema.safeParse({ items: [{ ...response.items[0], reason: '内部理由' }] }).success).toBe(false);
    expect(publicRaceAnnouncementsResponseSchema.safeParse({ items: [{ ...response.items[0], race: { ...response.items[0].race, assignments: [{ userId: id }] } }] }).success).toBe(false);
  });
  it('normalizes the expert race list without exposing management fields', () => {
    const item = {
      id: '11111111-1111-4111-8111-111111111111', raceDate: '2026-09-30', venue: '中山', number: 11,
      name: '担当レース', startsAt: new Date('2026-09-30T06:00:00.000Z'), status: 'SCHEDULED' as const
    };
    const parsed = expertRaceListResponseSchema.parse({ items: [item] });
    expect(parsed.items[0]?.startsAt).toBe('2026-09-30T06:00:00.000Z');
    expect(expertRaceListResponseSchema.safeParse({ items: [{ ...item, raceDayId: item.id, revision: 1 }] }).success).toBe(false);
    expect(expertRaceListResponseSchema.safeParse({ items: [{ ...item, assignments: [{ userId: item.id }] }] }).success).toBe(false);
  });
});
