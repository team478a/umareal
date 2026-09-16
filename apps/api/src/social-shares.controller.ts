import { Controller, ForbiddenException, Get, Inject, Query, Req } from '@nestjs/common';
import { buildRaceSocialShare, buildWin5SocialShare, canManage, requiresMfa } from '@keiba/domain';
import type { PredictionEvaluationStatus, Role, Win5EvaluationStatus } from '@keiba/domain';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

const predictionStatus = z.enum(['PRIMARY_WIN', 'PRIMARY_TOP2', 'PRIMARY_TOP3', 'WINNER_IN_RECOMMENDED', 'WINNER_NOT_RECOMMENDED', 'SKIPPED', 'EXCLUDED', 'CANCELED', 'REVIEW_REQUIRED']);
const win5Status = z.enum(['WIN5_ALL_WINNERS_RECOMMENDED', 'WIN5_PARTIAL', 'WIN5_MISSED', 'REVIEW_REQUIRED']);

@Controller()
export class SocialSharesController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'OPERATOR'] as Role[])) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'SNS共有候補の確認権限と二段階認証を確認してください。' });
  }

  @Get('admin/social-shares')
  async list(@Req() req: AppRequest, @Query('limit') rawLimit?: string) {
    await this.staff(req);
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(rawLimit);
    const [raceRows, win5Rows] = await Promise.all([
      this.auth.db.predictionEvaluation.findMany({
        where: { predictionVersion: { formatVersion: 'HORSE_EVALUATION_V1' } },
        orderBy: { confirmedAt: 'desc' },
        take: limit * 10,
        include: {
          race: { select: { id: true, raceDate: true, venue: true, number: true, name: true } },
          resultVersion: { select: { id: true, version: true } },
          predictionVersion: { select: { id: true, version: true, publishedAt: true } }
        }
      }),
      this.auth.db.win5EvaluationVersion.findMany({
        orderBy: { confirmedAt: 'desc' },
        take: limit * 2,
        include: {
          product: { select: { id: true, targetDate: true, title: true } },
          productVersion: { select: { id: true, version: true, publishedAt: true } }
        }
      })
    ]);

    raceRows.sort((a, b) => b.resultVersion.version - a.resultVersion.version || b.predictionVersion.version - a.predictionVersion.version || b.confirmedAt.getTime() - a.confirmedAt.getTime());
    const latestRace = new Map<string, typeof raceRows[number]>();
    for (const row of raceRows) if (!latestRace.has(row.raceId)) latestRace.set(row.raceId, row);

    const latestWin5 = new Map<string, typeof win5Rows[number]>();
    for (const row of win5Rows) if (!latestWin5.has(row.productId)) latestWin5.set(row.productId, row);

    const raceItems = [...latestRace.values()].map(row => {
      const status = predictionStatus.parse(row.status) as PredictionEvaluationStatus;
      const draft = buildRaceSocialShare({ venue: row.race.venue, raceNumber: row.race.number, raceName: row.race.name, status });
      return {
        id: row.id,
        kind: 'PADDOCK' as const,
        targetDate: row.race.raceDate,
        title: `${row.race.venue}${row.race.number}R ${row.race.name}`,
        status,
        resultVersion: row.resultVersion.version,
        predictionVersion: row.predictionVersion.version,
        publishedAt: row.predictionVersion.publishedAt,
        confirmedAt: row.confirmedAt,
        path: `/races/${row.race.id}`,
        ...draft
      };
    });
    const win5Items = [...latestWin5.values()].map(row => {
      const status = win5Status.parse(row.status) as Win5EvaluationStatus;
      const draft = buildWin5SocialShare({ targetDate: row.product.targetDate, status, recommendedLegs: row.recommendedLegs });
      return {
        id: row.id,
        kind: 'WIN5' as const,
        targetDate: row.product.targetDate,
        title: row.product.title,
        status,
        resultVersion: row.version,
        predictionVersion: row.productVersion.version,
        publishedAt: row.productVersion.publishedAt,
        confirmedAt: row.confirmedAt,
        path: `/win5/${row.product.id}`,
        ...draft
      };
    });
    const items = [...raceItems, ...win5Items].sort((a, b) => b.confirmedAt.getTime() - a.confirmedAt.getTime()).slice(0, limit);
    return { items };
  }
}
