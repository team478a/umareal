import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { assessmentSaveSchema, canEditRace } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';
const json = (data: unknown) => JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
@Controller('expert/races')
export class AssessmentsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private async access(tx: Prisma.TransactionClient, req: AppRequest, raceId: string) {
    const identity = await this.auth.authenticate(req);
    const race = await tx.race.findUnique({ where: { id: raceId }, include: { assignments: true } });
    if (!race) throw new NotFoundException();
    if (!canEditRace(identity, race.assignments.map(a => a.userId))) throw new ForbiddenException({ code: 'RACE_ACCESS_DENIED', message: '担当レースと二段階認証を確認してください。' });
    return race;
  }
  @Get(':raceId/assessments') async read(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    z.string().uuid().parse(raceId);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      const race = await this.access(tx, req, raceId);
      const entries = await tx.raceEntry.findMany({ where: { raceId }, orderBy: { number: 'asc' }, include: { assessment: true } });
      return { race: { id: race.id, name: race.name, venue: race.venue, number: race.number, startsAt: race.startsAt, status: race.status, revision: race.revision }, entries };
    });
  }
  @Get(':raceId/entries/:entryId/history') async history(@Req() req: AppRequest, @Param('raceId') raceId: string, @Param('entryId') entryId: string, @Query() query: unknown) {
    z.string().uuid().parse(raceId); z.string().uuid().parse(entryId);
    const { page } = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(query);
    await this.access(this.auth.db, req, raceId);
    const where = { assessment: { entryId, entry: { raceId } } };
    const [items, total] = await this.auth.db.$transaction([this.auth.db.assessmentVersion.findMany({ where, orderBy: { revision: 'desc' }, take: 20, skip: (page - 1) * 20 }), this.auth.db.assessmentVersion.count({ where })]);
    return { items, total, page, limit: 20 };
  }
  @Post(':raceId/entries/:entryId/assessment') async save(@Req() req: AppRequest, @Param('raceId') raceId: string, @Param('entryId') entryId: string, @Body() body: unknown) {
    z.string().uuid().parse(raceId); z.string().uuid().parse(entryId);
    const input = assessmentSaveSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      // Shares race-management lock: assignments, entries and revisions cannot change during a save.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      const race = await this.access(tx, req, raceId);
      const entry = await tx.raceEntry.findFirst({ where: { id: entryId, raceId }, include: { assessment: true } });
      if (!entry) throw new NotFoundException();
      const key = `assessment:${req.auth!.id}:${entryId}:${input.mutationId}`;
      const requestHash = hashToken(JSON.stringify(input));
      const prior = await tx.idempotencyKey.findUnique({ where: { key } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '再送の内容が変わっています。' });
        return prior.response;
      }
      if (race.revision !== input.raceRevision || entry.horseId !== input.horseId) throw new ConflictException({ code: 'RACE_CHANGED', message: '出走馬・担当・レース情報が変更されました。最新情報と入力を確認してください。' });
      if ((entry.assessment?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'ASSESSMENT_CONFLICT', message: '別の端末で評価が更新されました。両方の入力を確認してください。' });
      const revision = input.revision + 1;
      const saved = await tx.assessment.upsert({ where: { entryId }, create: { entryId, content: json(input.content), revision, updatedBy: req.auth!.id }, update: { content: json(input.content), revision, updatedBy: req.auth!.id, updatedAt: new Date() } });
      const { assessment: previous, ...snapshot } = entry;
      await tx.assessmentVersion.create({ data: { assessmentId: saved.id, revision, content: json(input.content), entrySnapshot: json(snapshot), actorId: req.auth!.id, reason: input.reason } });
      await tx.auditLog.create({ data: { actorId: req.auth!.id, actorRole: req.auth!.role, action: 'ASSESSMENT_SAVE', targetType: 'ASSESSMENT', targetId: saved.id, reason: input.reason, details: json({ before: previous, after: saved, raceId, entryId }), requestId: req.requestId } });
      await tx.idempotencyKey.create({ data: { key, requestHash, response: json(saved) } });
      return saved;
    }, { timeout: 20000, maxWait: 10000 });
  }
}
