import { describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import { ExpertRaceQueryService } from './expert-race-query.service';

const expertId = '11111111-1111-4111-8111-111111111111';
const raceId = '22222222-2222-4222-8222-222222222222';

describe('ExpertRaceQueryService', () => {
  it('limits an expert list to assigned races and selects only display fields', async () => {
    const startsAt = new Date('2026-10-10T06:00:00.000Z');
    const findMany = vi.fn().mockResolvedValue([{
      id: raceId,
      raceDate: '2026-10-10',
      venue: '東京',
      number: 11,
      name: '担当レース',
      startsAt,
      status: 'SCHEDULED',
    }]);
    const service = new ExpertRaceQueryService({ race: { findMany } } as unknown as DbService);

    const result = await service.list({ id: expertId, role: 'EXPERT' });

    expect(findMany).toHaveBeenCalledWith({
      where: { assignments: { some: { userId: expertId } } },
      take: 50,
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        raceDate: true,
        venue: true,
        number: true,
        name: true,
        startsAt: true,
        status: true,
      },
    });
    expect(result).toEqual({
      items: [{
        id: raceId,
        raceDate: '2026-10-10',
        venue: '東京',
        number: 11,
        name: '担当レース',
        startsAt: startsAt.toISOString(),
        status: 'SCHEDULED',
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/assignment|revision|entry|prediction|assessment/);
  });

  it('keeps operator and administrator lists unrestricted by assignment', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ExpertRaceQueryService({ race: { findMany } } as unknown as DbService);

    await service.list({ id: expertId, role: 'ADMIN' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('returns a strict workspace projection and separate assignment access context', async () => {
    const startsAt = new Date('2026-10-10T06:00:00.000Z');
    const findUnique = vi.fn().mockResolvedValue({
      id: raceId,
      name: '作業対象',
      startsAt,
      assignments: [{ userId: expertId }],
    });
    const service = new ExpertRaceQueryService({ race: { findUnique } } as unknown as DbService);

    const result = await service.workspace(raceId);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: raceId },
      select: {
        id: true,
        name: true,
        startsAt: true,
        assignments: { select: { userId: true } },
      },
    });
    expect(result).toEqual({
      response: {
        race: { id: raceId, name: '作業対象', startsAt: startsAt.toISOString() },
        inputEnabled: true,
      },
      assignedUserIds: [expertId],
    });
    expect(result?.response).not.toHaveProperty('assignments');
  });

  it('returns null when the workspace race does not exist', async () => {
    const service = new ExpertRaceQueryService({
      race: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as DbService);

    await expect(service.workspace(raceId)).resolves.toBeNull();
  });
});
