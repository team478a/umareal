import { describe, expect, it, vi } from 'vitest';
import { publicRaceListQuerySchema } from '@keiba/domain';
import type { DbService } from './db.service';
import { PublicRaceQueryService } from './public-race-query.service';

const raceId = '11111111-1111-4111-8111-111111111111';
const announcementId = '22222222-2222-4222-8222-222222222222';

describe('PublicRaceQueryService', () => {
  it('projects the existing public race list from an explicit safe selection', async () => {
    const now = new Date('2026-10-06T03:00:00.000Z');
    const startsAt = new Date('2026-10-06T06:00:00.000Z');
    const publishedAt = new Date('2026-10-06T02:00:00.000Z');
    const findMany = vi.fn()
      .mockResolvedValueOnce([{
        id: raceId,
        raceDate: '2026-10-06',
        venue: '東京',
        number: 9,
        name: '公開一覧試験',
        startsAt,
        status: 'SCHEDULED',
        raceDayId: null,
        raceClass: '3勝クラス',
        distance: 1800,
        surface: 'TURF',
        direction: 'LEFT',
        going: 'GOOD',
        weather: '晴',
        revision: 1,
        announcements: [{ version: 2, publishedAt }],
        prediction: { versions: [{ version: 3, status: 'CORRECTED', visibility: 'PAID', publishedAt }] },
        resultVersions: [],
      }])
      .mockResolvedValueOnce([{ venue: '東京' }, { venue: '中山' }]);
    const transaction = vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
    const service = new PublicRaceQueryService({
      $transaction: transaction,
      race: { findMany, count: vi.fn().mockResolvedValue(1) },
    } as unknown as DbService);

    const result = await service.list(publicRaceListQuerySchema.parse({}), now);

    expect(result).toMatchObject({
      total: 1,
      page: 1,
      limit: 20,
      filters: {
        date: '2026-10-06',
        dateFrom: '2026-10-06',
        dateTo: '2026-10-06',
        publication: 'ALL',
        result: 'ALL',
        venue: null,
        keyword: null,
        venues: ['東京', '中山'],
      },
      items: [{
        id: raceId,
        startsAt: startsAt.toISOString(),
        latestAnnouncement: { version: 2, publishedAt: publishedAt.toISOString() },
        latestPrediction: { version: 3, status: 'CORRECTED', visibility: 'PAID', publishedAt: publishedAt.toISOString() },
        latestResult: null,
      }],
    });
    const selection = findMany.mock.calls[0][0].select;
    expect(selection).toEqual(expect.objectContaining({ id: true, revision: true }));
    expect(selection).not.toHaveProperty('assignments');
    expect(selection).not.toHaveProperty('entries');
    expect(JSON.stringify(selection)).not.toMatch(/summary|contentSnapshot|assessmentSnapshot|publisherId/);
    expect(JSON.stringify(result)).not.toMatch(/summary|contentSnapshot|assignments|entries/);
  });

  it('returns only the newest recent published announcement for each active race', async () => {
    const now = new Date('2026-10-06T03:00:00.000Z');
    const startsAt = new Date('2026-10-06T06:00:00.000Z');
    const earlierId = '33333333-3333-4333-8333-333333333333';
    const findMany = vi.fn().mockResolvedValue([
      { id: announcementId, raceId, version: 2, publishedAt: new Date('2026-10-06T02:00:00.000Z'), race: { id: raceId, raceDate: '2026-10-06', venue: '東京', number: 9, name: '告知試験', startsAt } },
      { id: earlierId, raceId, version: 1, publishedAt: new Date('2026-10-06T01:00:00.000Z'), race: { id: raceId, raceDate: '2026-10-06', venue: '東京', number: 9, name: '告知試験', startsAt } },
    ]);
    const service = new PublicRaceQueryService({ raceAnnouncement: { findMany } } as unknown as DbService);

    const result = await service.announcements(now);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: announcementId, version: 2, race: { id: raceId, name: '告知試験' } });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        publishedAt: { lte: now },
        race: { startsAt: { gt: new Date('2026-10-05T21:00:00.000Z') }, status: { notIn: ['CANCELLED'] } },
      },
      take: 50,
    }));
    expect(JSON.stringify(findMany.mock.calls[0][0].select)).not.toMatch(/reason|publishedBy|assignments|entries|prediction/);
    expect(JSON.stringify(result)).not.toMatch(/reason|publishedBy|assignments|entries|prediction/);
  });
});
