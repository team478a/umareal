import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { canManage, dateSchema, freeMemberBenefitSchema, freeReportDraftSchema, freeReportPublishSchema, jstDate, requiresMfa } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const maxAudioBytes = 8 * 1024 * 1024;
const audioTypes = new Set(['audio/webm', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac']);
function hasAudioSignature(contentType: string, data: Buffer) {
  if (contentType === 'audio/webm') return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (['audio/mp4', 'audio/m4a', 'audio/x-m4a'].includes(contentType)) return data.subarray(4, 8).toString('ascii') === 'ftyp';
  if (contentType === 'audio/mpeg') return data.subarray(0, 3).toString('ascii') === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
  if (contentType === 'audio/ogg') return data.subarray(0, 4).toString('ascii') === 'OggS';
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE';
  return contentType === 'audio/aac' && data[0] === 0xff && (data[1] & 0xf6) === 0xf0;
}

@Controller('admin/free-reports')
export class AdminFreeReportsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'OPERATOR'])) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '無料速報を管理する権限と二段階認証を確認してください。' });
    return actor;
  }

  @Get('races')
  async races(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req);
    const { date } = z.object({ date: dateSchema.default(jstDate(new Date())) }).parse(query);
    const items = await this.auth.db.race.findMany({
      where: { raceDate: date }, orderBy: [{ venue: 'asc' }, { number: 'asc' }],
      select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true, _count: { select: { entries: true } }, freeReportDraft: { select: { revision: true } }, freeReportVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, kind: true, publishedAt: true } } }
    });
    return { items };
  }

  @Post('audio')
  async uploadAudio(@Req() req: AppRequest) {
    const actor = await this.staff(req);
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!audioTypes.has(contentType)) throw new BadRequestException({ code: 'AUDIO_TYPE_INVALID', message: 'WebM、MP4、MP3、OGG、WAV、AAC形式の音声を選択してください。' });
    const declaredSize = Number(req.headers['content-length'] ?? 0);
    if (declaredSize > maxAudioBytes) throw new BadRequestException({ code: 'AUDIO_TOO_LARGE', message: '音声は8MB以下にしてください。' });
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > maxAudioBytes) throw new BadRequestException({ code: 'AUDIO_TOO_LARGE', message: '音声は8MB以下にしてください。' });
      chunks.push(chunk);
    }
    if (!size) throw new BadRequestException({ code: 'AUDIO_EMPTY', message: '音声データがありません。' });
    const data = Buffer.concat(chunks);
    if (!hasAudioSignature(contentType, data)) throw new BadRequestException({ code: 'AUDIO_CONTENT_INVALID', message: '音声ファイルの内容を確認してください。' });
    return this.auth.db.$transaction(async tx => {
      const asset = await tx.audioAsset.create({ data: { contentType, data, sizeBytes: size, createdBy: actor.id } });
      await this.auth.audit(tx, req, 'FREE_REPORT_AUDIO_UPLOAD', asset.id, '無料速報の音声入力', { sizeBytes: size, contentType });
      return { id: asset.id, url: `/api/v1/free-report-audio/${asset.id}`, contentType: asset.contentType, sizeBytes: asset.sizeBytes };
    });
  }

  @Get('races/:raceId')
  async detail(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    await this.staff(req); z.string().uuid().parse(raceId);
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, select: {
      id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true,
      entries: { orderBy: { number: 'asc' }, select: { id: true, number: true, horseName: true, status: true } },
      freeReportDraft: true,
      freeReportVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, kind: true, upHorseNumber: true, upHorseName: true, upReason: true, downHorseNumber: true, downHorseName: true, downReason: true, audioUrl: true, reviewText: true, publishReason: true, publishedAt: true } },
      resultVersions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, confirmedAt: true } }
    } });
    if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
    return race;
  }

  @Patch('races/:raceId/draft')
  async save(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(raceId); const input = freeReportDraftSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      const race = await tx.race.findUnique({ where: { id: raceId }, include: { entries: { select: { id: true, status: true } }, freeReportDraft: true } });
      if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
      const entries = new Map(race.entries.map(entry => [entry.id, entry]));
      if (!entries.has(input.upEntryId) || !entries.has(input.downEntryId)) throw new BadRequestException({ code: 'FREE_REPORT_ENTRY_INVALID', message: 'このレースの出走馬を選択してください。' });
      if (entries.get(input.upEntryId)?.status !== 'ACTIVE' || entries.get(input.downEntryId)?.status !== 'ACTIVE') throw new BadRequestException({ code: 'FREE_REPORT_ENTRY_INACTIVE', message: '取消・除外された馬は無料速報に選択できません。' });
      if ((race.freeReportDraft?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'FREE_REPORT_DRAFT_CONFLICT', message: '別の担当者が無料速報を変更しました。再読み込みしてください。' });
      const data = { upEntryId: input.upEntryId, upReason: input.upReason, downEntryId: input.downEntryId, downReason: input.downReason, audioUrl: input.audioUrl, reviewText: input.reviewText, updatedBy: actor.id, updatedAt: new Date() };
      const draft = race.freeReportDraft
        ? await tx.freeReportDraft.update({ where: { raceId }, data: { ...data, revision: { increment: 1 } } })
        : await tx.freeReportDraft.create({ data: { raceId, ...data } });
      await this.auth.audit(tx, req, 'FREE_REPORT_DRAFT_SAVE', draft.id, input.reason, { raceId, revision: draft.revision, hasAudio: true, hasReview: !!draft.reviewText });
      return draft;
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Post('races/:raceId/publish')
  async publish(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(raceId); const input = freeReportPublishSchema.parse(body);
    const requestKey = z.string().uuid().parse(req.headers['idempotency-key']);
    const key = `free-report:${actor.id}:${raceId}:${requestKey}`; const requestHash = hashToken(JSON.stringify(input));
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      const previous = await tx.idempotencyKey.findUnique({ where: { key } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じリクエストキーの内容が変わっています。' });
        return previous.response;
      }
      const race = await tx.race.findUnique({ where: { id: raceId }, include: { entries: true, freeReportDraft: true, freeReportVersions: { orderBy: { version: 'desc' } }, resultVersions: { take: 1 } } });
      if (!race || !race.freeReportDraft) throw new NotFoundException({ code: 'FREE_REPORT_DRAFT_NOT_FOUND', message: '無料速報の下書きを保存してください。' });
      if (race.freeReportDraft.revision !== input.revision) throw new ConflictException({ code: 'FREE_REPORT_DRAFT_CONFLICT', message: '無料速報が変更されています。再確認してください。' });
      const now = new Date(); const latestPre = race.freeReportVersions.find(version => version.kind === 'PRE_RACE');
      if (input.kind === 'PRE_RACE' && (now >= race.startsAt || ['FINISHED', 'CANCELLED'].includes(race.status))) throw new ConflictException({ code: 'FREE_REPORT_PRE_RACE_CLOSED', message: '発走後または中止レースの事前速報は公開できません。' });
      if (input.kind === 'POST_RACE_REVIEW' && (!latestPre || now < race.startsAt || !race.resultVersions.length)) throw new ConflictException({ code: 'FREE_REPORT_REVIEW_NOT_READY', message: '事前速報と確定結果があり、発走時刻を過ぎてから検証を公開できます。' });
      if (input.kind === 'POST_RACE_REVIEW' && !race.freeReportDraft.reviewText.trim()) throw new BadRequestException({ code: 'FREE_REPORT_REVIEW_REQUIRED', message: 'レース後の検証コメントを入力してください。' });
      const entries = new Map(race.entries.map(entry => [entry.id, entry]));
      const up = input.kind === 'PRE_RACE' ? entries.get(race.freeReportDraft.upEntryId) : null;
      const down = input.kind === 'PRE_RACE' ? entries.get(race.freeReportDraft.downEntryId) : null;
      if (input.kind === 'PRE_RACE' && (!up || !down || up.status !== 'ACTIVE' || down.status !== 'ACTIVE')) throw new BadRequestException({ code: 'FREE_REPORT_ENTRY_INVALID', message: '選択した出走馬の状態を確認してください。' });
      const source = latestPre;
      const version = await tx.freeReportVersion.create({ data: {
        raceId, version: (race.freeReportVersions[0]?.version ?? 0) + 1, kind: input.kind,
        upEntryId: up?.id ?? source!.upEntryId, upHorseNumber: up?.number ?? source!.upHorseNumber, upHorseName: up?.horseName ?? source!.upHorseName, upReason: input.kind === 'PRE_RACE' ? race.freeReportDraft.upReason : source!.upReason,
        downEntryId: down?.id ?? source!.downEntryId, downHorseNumber: down?.number ?? source!.downHorseNumber, downHorseName: down?.horseName ?? source!.downHorseName, downReason: input.kind === 'PRE_RACE' ? race.freeReportDraft.downReason : source!.downReason,
        audioUrl: input.kind === 'PRE_RACE' ? race.freeReportDraft.audioUrl : source!.audioUrl,
        reviewText: input.kind === 'POST_RACE_REVIEW' ? race.freeReportDraft.reviewText : null,
        publishedBy: actor.id, publishReason: input.reason
      } });
      await tx.notificationEvent.create({ data: { freeReportVersionId: version.id, eventType: input.kind === 'PRE_RACE' ? 'FREE_REPORT_PUBLISHED' : 'FREE_REPORT_REVIEW_PUBLISHED', status: 'QUEUED', payload: json({ freeReportVersionId: version.id, raceId }) } });
      await this.auth.audit(tx, req, input.kind === 'PRE_RACE' ? 'FREE_REPORT_PUBLISH' : 'FREE_REPORT_REVIEW_PUBLISH', version.id, input.reason, { raceId, version: version.version, kind: version.kind });
      const response = json({ id: version.id, version: version.version, kind: version.kind, publishedAt: version.publishedAt });
      await tx.idempotencyKey.create({ data: { key, requestHash, response } });
      return response;
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Get('benefit')
  async benefit(@Req() req: AppRequest) {
    await this.staff(req);
    return (await this.auth.db.freeMemberBenefit.findUnique({ where: { id: 'global' } })) ?? { id: 'global', title: '', description: '', videoUrl: '', revision: 0, updatedAt: null };
  }

  @Patch('benefit')
  async saveBenefit(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req); const input = freeMemberBenefitSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      const before = await tx.freeMemberBenefit.findUnique({ where: { id: 'global' } });
      if ((before?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'FREE_BENEFIT_CONFLICT', message: '登録特典が変更されています。再読み込みしてください。' });
      const benefit = before
        ? await tx.freeMemberBenefit.update({ where: { id: 'global' }, data: { title: input.title, description: input.description, videoUrl: input.videoUrl, updatedBy: actor.id, updatedAt: new Date(), revision: { increment: 1 } } })
        : await tx.freeMemberBenefit.create({ data: { id: 'global', title: input.title, description: input.description, videoUrl: input.videoUrl, updatedBy: actor.id } });
      await this.auth.audit(tx, req, 'FREE_MEMBER_BENEFIT_UPDATE', benefit.id, input.reason, { revision: benefit.revision, videoConfigured: true });
      return benefit;
    }, { timeout: 20000, maxWait: 10000 });
  }
}

@Controller()
export class MemberFreeReportsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('me/free-benefit')
  async benefit(@Req() req: AppRequest) {
    await this.auth.authenticate(req);
    const value = await this.auth.db.freeMemberBenefit.findUnique({ where: { id: 'global' }, select: { title: true, description: true, videoUrl: true, updatedAt: true } });
    return value ? { configured: true, ...value } : { configured: false };
  }

  @Get('races/:raceId/free-report')
  async report(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    await this.auth.authenticate(req); z.string().uuid().parse(raceId);
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, freeReportVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, kind: true, upHorseNumber: true, upHorseName: true, upReason: true, downHorseNumber: true, downHorseName: true, downReason: true, audioUrl: true, reviewText: true, publishedAt: true } } } });
    if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
    return { race: { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt }, versions: race.freeReportVersions };
  }

  @Get('free-report-audio/:audioId')
  async audio(@Req() req: AppRequest, @Res() res: Response, @Param('audioId') audioId: string) {
    const actor = await this.auth.authenticate(req); z.string().uuid().parse(audioId);
    const url = `/api/v1/free-report-audio/${audioId}`;
    const staff = canManage(actor, ['ADMIN', 'OPERATOR']);
    if (!staff && !await this.auth.db.freeReportVersion.findFirst({ where: { audioUrl: url }, select: { id: true } })) throw new NotFoundException({ code: 'AUDIO_NOT_FOUND', message: '音声が見つかりません。' });
    const asset = await this.auth.db.audioAsset.findUnique({ where: { id: audioId } });
    if (!asset) throw new NotFoundException({ code: 'AUDIO_NOT_FOUND', message: '音声が見つかりません。' });
    const data = Buffer.from(asset.data); let start = 0; let end = data.length - 1; let partial = false;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) { res.status(416).setHeader('Content-Range', `bytes */${data.length}`).end(); return; }
      if (!match[1] && match[2]) { const suffix = Math.min(Number(match[2]), data.length); start = data.length - suffix; }
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= data.length) { res.status(416).setHeader('Content-Range', `bytes */${data.length}`).end(); return; }
      partial = true;
    }
    const body = data.subarray(start, end + 1);
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
    res.status(partial ? 206 : 200).end(body);
  }
}
