import { describe, expect, it } from 'vitest';
import { CsvRaceDataProvider, dateSchema, entryHeaders, parseCsv, raceHeaders, raceInputSchema } from './races';
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
});
