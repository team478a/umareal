import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { CsvRaceDataProvider, dateSchema, entryHeaders, parseCsv, parseJraVanRaceBundle, raceHeaders, raceInputSchema } from './races';
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
});
