import { Inject, Injectable } from '@nestjs/common';
import {
  expertRaceListResponseSchema,
  expertRaceWorkspaceResponseSchema,
} from '@keiba/domain';
import type {
  ExpertRaceListResponse,
  ExpertRaceWorkspaceResponse,
  Role,
} from '@keiba/domain';
import { DbService } from './db.service';

type ExpertRaceQueryActor = {
  id: string;
  role: Role;
};

export type ExpertRaceWorkspaceAccess = {
  response: ExpertRaceWorkspaceResponse;
  assignedUserIds: string[];
};

@Injectable()
export class ExpertRaceQueryService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(actor: ExpertRaceQueryActor): Promise<ExpertRaceListResponse> {
    const items = await this.db.race.findMany({
      where: actor.role === 'EXPERT' ? { assignments: { some: { userId: actor.id } } } : {},
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

    return expertRaceListResponseSchema.parse({ items });
  }

  async workspace(raceId: string): Promise<ExpertRaceWorkspaceAccess | null> {
    const race = await this.db.race.findUnique({
      where: { id: raceId },
      select: {
        id: true,
        name: true,
        startsAt: true,
        assignments: { select: { userId: true } },
      },
    });
    if (!race) return null;

    return {
      response: expertRaceWorkspaceResponseSchema.parse({
        race: { id: race.id, name: race.name, startsAt: race.startsAt },
        inputEnabled: true,
      }),
      assignedUserIds: race.assignments.map(assignment => assignment.userId),
    };
  }
}
