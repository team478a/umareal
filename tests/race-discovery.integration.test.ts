import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';

beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Integration suite is limited to a local development database');
});
afterAll(() => db.$disconnect());

describe('public race discovery', () => {
  it('filters by date, venue and publication state without returning prediction content', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8); const month = String(parseInt(suffix.slice(0, 2), 16) % 12 + 1).padStart(2, '0'); const day = String(parseInt(suffix.slice(2, 4), 16) % 28 + 1).padStart(2, '0'); const date = `2096-${month}-${day}`; const publisher = await account('ADMIN');
    const freeRace = await db.race.create({ data: { raceDate: date, venue: `一覧A${suffix}`, number: 1, name: `無料一覧${suffix}`, startsAt: new Date(`${date}T10:00:00+09:00`) } });
    const paidRace = await db.race.create({ data: { raceDate: date, venue: `一覧B${suffix}`, number: 2, name: `有料一覧${suffix}`, startsAt: new Date(`${date}T11:00:00+09:00`) } });
    const announcedRace = await db.race.create({ data: { raceDate: date, venue: `一覧A${suffix}`, number: 3, name: `告知一覧${suffix}`, startsAt: new Date(`${date}T12:00:00+09:00`) } });
    for (const [race, visibility, secret] of [[freeRace, 'FREE', '無料の秘密本文'], [paidRace, 'PAID', '有料の秘密本文']] as const) {
      const prediction = await db.prediction.create({ data: { raceId: race.id, draft: {}, revision: 1, updatedBy: publisher.user.id } });
      await db.predictionVersion.create({ data: { predictionId: prediction.id, version: 1, status: 'PUBLISHED', visibility, confidence: 'S', stance: 'SKIP', summary: secret, estimatedTotalYen: 0, contentSnapshot: { secret }, assessmentSnapshot: {}, publisherId: publisher.user.id, deadlineAt: race.startsAt } });
    }
    await db.raceAnnouncement.create({ data: { raceId: announcedRace.id, version: 1, publishedBy: publisher.user.id, reason: '一覧の告知試験' } });

    const client = new Client(); const all = await client.call(`races?date=${date}&limit=50`);
    expect(all.status).toBe(200); expect(all.body.total).toBeGreaterThanOrEqual(3); expect(all.body.filters.venues).toEqual(expect.arrayContaining([`一覧A${suffix}`, `一覧B${suffix}`]));
    expect(all.body.items.map((race: { id: string }) => race.id)).toEqual(expect.arrayContaining([freeRace.id, paidRace.id, announcedRace.id]));
    expect(all.body.items.find((race: { id: string }) => race.id === paidRace.id).latestPrediction).toMatchObject({ visibility: 'PAID', version: 1 });
    expect(JSON.stringify(all.body)).not.toMatch(/無料の秘密本文|有料の秘密本文|contentSnapshot|confidence|summary/);
    expect((await client.call(`races?date=${date}&publication=PUBLISHED`)).body.items.map((race: { id: string }) => race.id)).toEqual(expect.arrayContaining([freeRace.id, paidRace.id]));
    expect((await client.call(`races?date=${date}&publication=UNPUBLISHED`)).body.items.map((race: { id: string }) => race.id)).toContain(announcedRace.id);
    expect((await client.call(`races?date=${date}&publication=ANNOUNCED`)).body.items.map((race: { id: string }) => race.id)).toContain(announcedRace.id);
    expect((await client.call(`races?date=${date}&venue=${encodeURIComponent(`一覧B${suffix}`)}`)).body.items.map((race: { id: string }) => race.id)).toEqual([paidRace.id]);
    expect((await client.call(`races?date=${date}&publication=SECRET`)).status).toBe(400);
  });
});
