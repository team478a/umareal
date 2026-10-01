import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { adminFreeMemberBenefitItemSchema, adminFreeMemberBenefitListResponseSchema, adminFreeMemberBenefitResponseSchema, adminFreeReportAudioUploadResponseSchema, adminFreeReportDraftResponseSchema, adminFreeReportPublishResponseSchema, adminFreeReportRaceDetailResponseSchema, adminFreeReportRaceListResponseSchema, canManage, dateSchema, freeMemberBenefitCreateSchema, freeMemberBenefitSchema, freeReportAudioContentTypes, freeReportDraftSchema, freeReportPublishSchema, jstDate, publicFreeMemberBenefitListResponseSchema, publicFreeMemberBenefitResponseSchema, publicFreeMemberBenefitViewResponseSchema, publicFreeReportMetadataResponseSchema, requiresMfa } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const freeMemberBenefitSelect = { id: true, title: true, description: true, videoUrl: true, revision: true, updatedBy: true, updatedAt: true } satisfies Prisma.FreeMemberBenefitSelect;
const freeMemberBenefitListSelect = { id: true, title: true, description: true, videoUrl: true, revision: true, createdAt: true, updatedBy: true, updatedAt: true } satisfies Prisma.FreeMemberBenefitSelect;
const freeReportDraftSelect = { id: true, raceId: true, upEntryId: true, upReason: true, downEntryId: true, downReason: true, audioUrl: true, reviewText: true, revision: true, updatedBy: true, updatedAt: true } satisfies Prisma.FreeReportDraftSelect;
const maxAudioBytes = 8 * 1024 * 1024;
const audioTypes = new Set<string>(freeReportAudioContentTypes);
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

  private async benefitAudience(db: Prisma.TransactionClient | AuthService['db'], benefitId = 'global') {
    const eligible = { role: 'MEMBER' as const, registrationMethod: 'LINE', disabledAt: null };
    const [eligibleMembers, viewedMembers] = await Promise.all([
      db.user.count({ where: eligible }),
      db.freeMemberBenefitView.count({ where: { benefitId, user: eligible } })
    ]);
    return { eligibleMembers, viewedMembers };
  }

  private async benefits(db: Prisma.TransactionClient | AuthService['db']) {
    const eligible = { role: 'MEMBER' as const, registrationMethod: 'LINE', disabledAt: null };
    const [eligibleMembers, benefits] = await Promise.all([
      db.user.count({ where: eligible }),
      db.freeMemberBenefit.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: freeMemberBenefitListSelect })
    ]);
    const viewedMembers = await Promise.all(benefits.map(benefit => db.freeMemberBenefitView.count({ where: { benefitId: benefit.id, user: eligible } })));
    return adminFreeMemberBenefitListResponseSchema.parse({ eligibleMembers, items: benefits.map((benefit, index) => ({ ...benefit, viewedMembers: viewedMembers[index] })) });
  }

  @Get('races')
  async races(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req);
    const { date } = z.object({ date: dateSchema.default(jstDate(new Date())) }).parse(query);
    const items = await this.auth.db.race.findMany({
      where: { raceDate: date }, orderBy: [{ venue: 'asc' }, { number: 'asc' }],
      select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true, _count: { select: { entries: true } }, freeReportDraft: { select: { revision: true } }, freeReportVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, kind: true, publishedAt: true } } }
    });
    return adminFreeReportRaceListResponseSchema.parse({ items });
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
      const asset = await tx.audioAsset.create({ data: { contentType, data, sizeBytes: size, createdBy: actor.id }, select: { id: true, contentType: true, sizeBytes: true } });
      await this.auth.audit(tx, req, 'FREE_REPORT_AUDIO_UPLOAD', asset.id, '無料速報の音声入力', { sizeBytes: size, contentType });
      return adminFreeReportAudioUploadResponseSchema.parse({ id: asset.id, url: `/api/v1/free-report-audio/${asset.id}`, contentType: asset.contentType, sizeBytes: asset.sizeBytes });
    });
  }

  @Get('races/:raceId')
  async detail(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    await this.staff(req); z.string().uuid().parse(raceId);
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, select: {
      id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true,
      entries: { orderBy: { number: 'asc' }, select: { id: true, number: true, horseName: true, status: true } },
      freeReportDraft: { select: { id: true, raceId: true, upEntryId: true, upReason: true, downEntryId: true, downReason: true, audioUrl: true, reviewText: true, revision: true, updatedBy: true, updatedAt: true } },
      freeReportVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, kind: true, upHorseNumber: true, upHorseName: true, upReason: true, downHorseNumber: true, downHorseName: true, downReason: true, audioUrl: true, reviewText: true, publishReason: true, publishedAt: true } },
      resultVersions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, confirmedAt: true } }
    } });
    if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
    return adminFreeReportRaceDetailResponseSchema.parse(race);
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
        ? await tx.freeReportDraft.update({ where: { raceId }, data: { ...data, revision: { increment: 1 } }, select: freeReportDraftSelect })
        : await tx.freeReportDraft.create({ data: { raceId, ...data }, select: freeReportDraftSelect });
      await this.auth.audit(tx, req, 'FREE_REPORT_DRAFT_SAVE', draft.id, input.reason, { raceId, revision: draft.revision, hasAudio: true, hasReview: !!draft.reviewText });
      return adminFreeReportDraftResponseSchema.parse(draft);
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
        return adminFreeReportPublishResponseSchema.parse(previous.response);
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
      const response = adminFreeReportPublishResponseSchema.parse({ id: version.id, version: version.version, kind: version.kind, publishedAt: version.publishedAt });
      await tx.idempotencyKey.create({ data: { key, requestHash, response: json(response) } });
      return response;
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Get('benefit')
  async benefit(@Req() req: AppRequest) {
    await this.staff(req);
    const [benefit, audience] = await Promise.all([
      this.auth.db.freeMemberBenefit.findUnique({ where: { id: 'global' }, select: freeMemberBenefitSelect }),
      this.benefitAudience(this.auth.db)
    ]);
    return adminFreeMemberBenefitResponseSchema.parse({ ...(benefit ?? { id: 'global' as const, title: '' as const, description: '' as const, videoUrl: '' as const, revision: 0 as const, updatedAt: null }), audience });
  }

  @Get('benefits')
  async benefitList(@Req() req: AppRequest) {
    await this.staff(req);
    return this.benefits(this.auth.db);
  }

  @Post('benefits')
  async createBenefit(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req); const input = freeMemberBenefitCreateSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      const benefit = await tx.freeMemberBenefit.create({ data: { id: randomUUID(), title: input.title, description: input.description, videoUrl: input.videoUrl, createdBy: actor.id, updatedBy: actor.id }, select: freeMemberBenefitListSelect });
      await this.auth.audit(tx, req, 'FREE_MEMBER_BENEFIT_CREATE', benefit.id, input.reason, { revision: benefit.revision, videoConfigured: true }, 'FREE_MEMBER_BENEFIT');
      return adminFreeMemberBenefitItemSchema.parse({ ...benefit, viewedMembers: 0 });
    });
  }

  @Patch('benefits/:benefitId')
  async updateBenefit(@Req() req: AppRequest, @Param('benefitId') benefitId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().trim().min(1).max(100).parse(benefitId); const input = freeMemberBenefitSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`free-member-benefit:${benefitId}`}))::text`;
      const before = await tx.freeMemberBenefit.findUnique({ where: { id: benefitId } });
      if (!before) throw new NotFoundException({ code: 'FREE_BENEFIT_NOT_FOUND', message: '登録特典が見つかりません。' });
      if (before.revision !== input.revision) throw new ConflictException({ code: 'FREE_BENEFIT_CONFLICT', message: '登録特典が変更されています。再読み込みしてください。' });
      const benefit = await tx.freeMemberBenefit.update({ where: { id: benefitId }, data: { title: input.title, description: input.description, videoUrl: input.videoUrl, updatedBy: actor.id, updatedAt: new Date(), revision: { increment: 1 } }, select: freeMemberBenefitListSelect });
      await this.auth.audit(tx, req, 'FREE_MEMBER_BENEFIT_UPDATE', benefit.id, input.reason, { revision: benefit.revision, videoConfigured: true }, 'FREE_MEMBER_BENEFIT');
      const audience = await this.benefitAudience(tx, benefit.id);
      return adminFreeMemberBenefitItemSchema.parse({ ...benefit, viewedMembers: audience.viewedMembers });
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Patch('benefit')
  async saveBenefit(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req); const input = freeMemberBenefitSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      const before = await tx.freeMemberBenefit.findUnique({ where: { id: 'global' } });
      if ((before?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'FREE_BENEFIT_CONFLICT', message: '登録特典が変更されています。再読み込みしてください。' });
      const benefit = before
        ? await tx.freeMemberBenefit.update({ where: { id: 'global' }, data: { title: input.title, description: input.description, videoUrl: input.videoUrl, updatedBy: actor.id, updatedAt: new Date(), revision: { increment: 1 } }, select: freeMemberBenefitSelect })
        : await tx.freeMemberBenefit.create({ data: { id: 'global', title: input.title, description: input.description, videoUrl: input.videoUrl, updatedBy: actor.id }, select: freeMemberBenefitSelect });
      await this.auth.audit(tx, req, 'FREE_MEMBER_BENEFIT_UPDATE', benefit.id, input.reason, { revision: benefit.revision, videoConfigured: true }, 'FREE_MEMBER_BENEFIT');
      const audience = await this.benefitAudience(tx);
      return adminFreeMemberBenefitResponseSchema.parse({ ...benefit, audience });
    }, { timeout: 20000, maxWait: 10000 });
  }
}

@Controller()
export class MemberFreeReportsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('me/free-benefit')
  async benefit(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER' || actor.user.registrationMethod !== 'LINE') return publicFreeMemberBenefitResponseSchema.parse({ configured: false });
    const [value, viewed] = await Promise.all([
      this.auth.db.freeMemberBenefit.findUnique({ where: { id: 'global' }, select: { title: true, description: true, updatedAt: true } }),
      this.auth.db.freeMemberBenefitView.findUnique({ where: { userId_benefitId: { userId: actor.id, benefitId: 'global' } }, select: { viewedAt: true } })
    ]);
    return publicFreeMemberBenefitResponseSchema.parse(value ? { configured: true, ...value, viewedAt: viewed?.viewedAt ?? null } : { configured: false });
  }

  @Get('me/free-benefits')
  async benefits(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER' || actor.user.registrationMethod !== 'LINE') return publicFreeMemberBenefitListResponseSchema.parse({ items: [] });
    const values = await this.auth.db.freeMemberBenefit.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, title: true, description: true, createdAt: true, updatedAt: true, views: { where: { userId: actor.id }, take: 1, select: { viewedAt: true } } }
    });
    return publicFreeMemberBenefitListResponseSchema.parse({ items: values.map(({ views, ...value }) => ({ ...value, viewedAt: views[0]?.viewedAt ?? null })) });
  }

  @Post('me/free-benefit/view')
  async viewBenefit(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER' || actor.user.registrationMethod !== 'LINE') throw new NotFoundException({ code: 'FREE_BENEFIT_NOT_FOUND', message: '登録特典が見つかりません。' });
    return this.auth.db.$transaction(async tx => {
      const value = await tx.freeMemberBenefit.findUnique({ where: { id: 'global' }, select: { id: true, videoUrl: true } });
      if (!value) throw new NotFoundException({ code: 'FREE_BENEFIT_NOT_FOUND', message: '登録特典が見つかりません。' });
      const view = await tx.freeMemberBenefitView.upsert({ where: { userId_benefitId: { userId: actor.id, benefitId: value.id } }, create: { userId: actor.id, benefitId: value.id }, update: {}, select: { viewedAt: true } });
      await this.auth.journey(tx, actor.id, 'REGISTRATION_BENEFIT_VIEWED');
      return publicFreeMemberBenefitViewResponseSchema.parse({ videoUrl: value.videoUrl, viewedAt: view.viewedAt });
    });
  }

  @Post('me/free-benefits/:benefitId/view')
  async viewBenefitById(@Req() req: AppRequest, @Param('benefitId') benefitId: string) {
    const actor = await this.auth.authenticate(req); z.string().trim().min(1).max(100).parse(benefitId);
    if (actor.role !== 'MEMBER' || actor.user.registrationMethod !== 'LINE') throw new NotFoundException({ code: 'FREE_BENEFIT_NOT_FOUND', message: '登録特典が見つかりません。' });
    return this.auth.db.$transaction(async tx => {
      const value = await tx.freeMemberBenefit.findUnique({ where: { id: benefitId }, select: { id: true, videoUrl: true } });
      if (!value) throw new NotFoundException({ code: 'FREE_BENEFIT_NOT_FOUND', message: '登録特典が見つかりません。' });
      const view = await tx.freeMemberBenefitView.upsert({ where: { userId_benefitId: { userId: actor.id, benefitId: value.id } }, create: { userId: actor.id, benefitId: value.id }, update: {}, select: { viewedAt: true } });
      await this.auth.journey(tx, actor.id, 'REGISTRATION_BENEFIT_VIEWED');
      return publicFreeMemberBenefitViewResponseSchema.parse({ videoUrl: value.videoUrl, viewedAt: view.viewedAt });
    });
  }

  @Get('races/:raceId/free-report')
  async report(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    await this.auth.authenticate(req); z.string().uuid().parse(raceId);
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, freeReportVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, kind: true, publishedAt: true } } } });
    if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
    return publicFreeReportMetadataResponseSchema.parse({ race: { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt }, versions: race.freeReportVersions });
  }

  @Get('free-report-audio/:audioId')
  async audio(@Req() req: AppRequest, @Res() res: Response, @Param('audioId') audioId: string) {
    const actor = await this.auth.authenticate(req); z.string().uuid().parse(audioId);
    const staff = canManage(actor, ['ADMIN', 'OPERATOR']);
    if (!staff) throw new NotFoundException({ code: 'AUDIO_NOT_FOUND', message: '音声が見つかりません。' });
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
