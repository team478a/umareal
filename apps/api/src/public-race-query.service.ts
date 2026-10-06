import { Inject, Injectable } from '@nestjs/common';
import {
  jstDate,
  publicRaceAnnouncementsResponseSchema,
  publicRaceListResponseSchema,
} from '@keiba/domain';
import type {
  PublicRaceAnnouncementsResponse,
  PublicRaceListQuery,
  PublicRaceListResponse,
} from '@keiba/domain';
import type { Prisma } from '@keiba/db';
import { DbService } from './db.service';

@Injectable()
export class PublicRaceQueryService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(query: PublicRaceListQuery, now = new Date()): Promise<PublicRaceListResponse> {
    const date = query.date ?? (!query.dateFrom ? jstDate(now) : undefined);
    const dateFrom = query.dateFrom ?? date!;
    const dateTo = query.dateTo ?? date!;
    const { page, limit, publication, result, venue, keyword } = query;
    const conditions: Prisma.RaceWhereInput[] = [
      { raceDate: date ? date : { gte: dateFrom, lte: dateTo } },
      ...(venue ? [{ venue }] : []),
      ...(keyword ? [{ OR: [{ name: { contains: keyword, mode: 'insensitive' as const } }, { entries: { some: { horseName: { contains: keyword, mode: 'insensitive' as const } } } }] }] : []),
      ...(publication === 'ANNOUNCED' ? [{ announcements: { some: {} } }] : publication === 'PUBLISHED' ? [{ prediction: { versions: { some: {} } } }] : publication === 'UNPUBLISHED' ? [{ OR: [{ prediction: null }, { prediction: { versions: { none: {} } } }] }] : []),
      ...(result === 'CONFIRMED' ? [{ resultVersions: { some: {} } }] : result === 'PENDING' ? [{ resultVersions: { none: {} } }] : []),
    ];
    const where: Prisma.RaceWhereInput = { AND: conditions };
    const venueWhere: Prisma.RaceWhereInput = { raceDate: date ? date : { gte: dateFrom, lte: dateTo } };
    const [rows, total, venueRows] = await this.db.$transaction([
      this.db.race.findMany({
        where,
        orderBy: date ? [{ startsAt: 'asc' }, { id: 'asc' }] : [{ raceDate: 'desc' }, { startsAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          raceDate: true,
          venue: true,
          number: true,
          name: true,
          startsAt: true,
          status: true,
          raceDayId: true,
          raceClass: true,
          distance: true,
          surface: true,
          direction: true,
          going: true,
          weather: true,
          revision: true,
          announcements: { orderBy: { version: 'desc' }, take: 1, select: { version: true, publishedAt: true } },
          prediction: { select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, status: true, visibility: true, publishedAt: true } } } },
          resultVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, raceCanceled: true, confirmedAt: true } },
        },
      }),
      this.db.race.count({ where }),
      this.db.race.findMany({ where: venueWhere, distinct: ['venue'], select: { venue: true }, orderBy: { venue: 'asc' } }),
    ]);
    const items = rows.map(({ announcements, prediction, resultVersions, ...race }) => ({
      ...race,
      latestAnnouncement: announcements[0] ?? null,
      latestPrediction: prediction?.versions[0] ?? null,
      latestResult: resultVersions[0] ?? null,
    }));
    return publicRaceListResponseSchema.parse({
      items,
      total,
      page,
      limit,
      filters: {
        date: date ?? null,
        dateFrom,
        dateTo,
        publication,
        result,
        venue: venue ?? null,
        keyword: keyword ?? null,
        venues: venueRows.map(item => item.venue),
      },
    });
  }

  async announcements(now = new Date()): Promise<PublicRaceAnnouncementsResponse> {
    const rows = await this.db.raceAnnouncement.findMany({
      where: {
        publishedAt: { lte: now },
        race: {
          startsAt: { gt: new Date(now.getTime() - 6 * 3600000) },
          status: { notIn: ['CANCELLED'] },
        },
      },
      select: {
        id: true,
        raceId: true,
        version: true,
        publishedAt: true,
        race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } },
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
      take: 50,
    });
    const seen = new Set<string>();
    const items = rows.filter(row => {
      if (seen.has(row.raceId)) return false;
      seen.add(row.raceId);
      return true;
    }).slice(0, 10);
    return publicRaceAnnouncementsResponseSchema.parse({
      items: items.map(row => ({
        id: row.id,
        version: row.version,
        publishedAt: row.publishedAt,
        race: row.race,
      })),
    });
  }
}
