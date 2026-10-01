import { z } from 'zod';
import { dateSchema, entryStatuses, raceStatuses } from './races';

const httpsUrl = z.string().trim().url().max(1000).refine(value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } }, 'HTTPSのURLを指定してください。');
const audioSource = z.string().trim().max(1000).refine(value => /^\/api\/v1\/free-report-audio\/[0-9a-f-]{36}$/.test(value) || (() => { try { return new URL(value).protocol === 'https:'; } catch { return false; } })(), '録音済み音声またはHTTPSのURLを指定してください。');
export const freeReportAudioContentTypes = ['audio/webm', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac'] as const;

const publicFreeReportDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);
export const publicFreeMemberBenefitResponseSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }).strict(),
  z.object({
    configured: z.literal(true),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    updatedAt: publicFreeReportDateTimeSchema,
    viewedAt: publicFreeReportDateTimeSchema.nullable()
  }).strict()
]);
export type PublicFreeMemberBenefitResponse = z.infer<typeof publicFreeMemberBenefitResponseSchema>;

export const publicFreeMemberBenefitItemSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  createdAt: publicFreeReportDateTimeSchema,
  updatedAt: publicFreeReportDateTimeSchema,
  viewedAt: publicFreeReportDateTimeSchema.nullable()
}).strict();
export const publicFreeMemberBenefitListResponseSchema = z.object({ items: z.array(publicFreeMemberBenefitItemSchema) }).strict();
export type PublicFreeMemberBenefitListResponse = z.infer<typeof publicFreeMemberBenefitListResponseSchema>;

export const publicFreeMemberBenefitViewResponseSchema = z.object({
  videoUrl: httpsUrl,
  viewedAt: publicFreeReportDateTimeSchema
}).strict();
export type PublicFreeMemberBenefitViewResponse = z.infer<typeof publicFreeMemberBenefitViewResponseSchema>;

const publicFreeReportVersionMetadataSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  kind: z.enum(['PRE_RACE', 'POST_RACE_REVIEW']),
  publishedAt: publicFreeReportDateTimeSchema
}).strict();
export const publicFreeReportMetadataResponseSchema = z.object({
  race: z.object({
    id: z.string().uuid(),
    raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    venue: z.string().min(1),
    number: z.number().int().min(1).max(12),
    name: z.string().min(1),
    startsAt: publicFreeReportDateTimeSchema
  }).strict(),
  versions: z.array(publicFreeReportVersionMetadataSchema)
}).strict();
export type PublicFreeReportMetadataResponse = z.infer<typeof publicFreeReportMetadataResponseSchema>;

export const adminFreeReportRaceListResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    raceDate: dateSchema,
    venue: z.string().min(1),
    number: z.number().int().min(1).max(12),
    name: z.string().min(1),
    startsAt: publicFreeReportDateTimeSchema,
    status: z.enum(raceStatuses),
    _count: z.object({ entries: z.number().int().nonnegative() }).strict(),
    freeReportDraft: z.object({ revision: z.number().int().positive() }).strict().nullable(),
    freeReportVersions: z.array(z.object({
      version: z.number().int().positive(),
      kind: z.enum(['PRE_RACE', 'POST_RACE_REVIEW']),
      publishedAt: publicFreeReportDateTimeSchema
    }).strict()).max(1)
  }).strict())
}).strict();
export type AdminFreeReportRaceListResponse = z.infer<typeof adminFreeReportRaceListResponseSchema>;

export const adminFreeReportRaceDetailResponseSchema = z.object({
  id: z.string().uuid(),
  raceDate: dateSchema,
  venue: z.string().min(1),
  number: z.number().int().min(1).max(12),
  name: z.string().min(1),
  startsAt: publicFreeReportDateTimeSchema,
  status: z.enum(raceStatuses),
  entries: z.array(z.object({
    id: z.string().uuid(),
    number: z.number().int().min(1).max(18),
    horseName: z.string().min(1),
    status: z.enum(entryStatuses)
  }).strict()),
  freeReportDraft: z.object({
    id: z.string().uuid(),
    raceId: z.string().uuid(),
    upEntryId: z.string().uuid(),
    upReason: z.string(),
    downEntryId: z.string().uuid(),
    downReason: z.string(),
    audioUrl: z.string(),
    reviewText: z.string(),
    revision: z.number().int().positive(),
    updatedBy: z.string().uuid(),
    updatedAt: publicFreeReportDateTimeSchema
  }).strict().nullable(),
  freeReportVersions: z.array(z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    kind: z.enum(['PRE_RACE', 'POST_RACE_REVIEW']),
    upHorseNumber: z.number().int().min(1).max(18),
    upHorseName: z.string().min(1),
    upReason: z.string(),
    downHorseNumber: z.number().int().min(1).max(18),
    downHorseName: z.string().min(1),
    downReason: z.string(),
    audioUrl: z.string(),
    reviewText: z.string().nullable(),
    publishReason: z.string(),
    publishedAt: publicFreeReportDateTimeSchema
  }).strict()),
  resultVersions: z.array(z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    confirmedAt: publicFreeReportDateTimeSchema
  }).strict()).max(1)
}).strict();
export type AdminFreeReportRaceDetailResponse = z.infer<typeof adminFreeReportRaceDetailResponseSchema>;

export const adminFreeMemberBenefitResponseSchema = z.union([
  z.object({
    id: z.literal('global'),
    title: z.literal(''),
    description: z.literal(''),
    videoUrl: z.literal(''),
    revision: z.literal(0),
    updatedAt: z.null(),
    audience: z.object({ eligibleMembers: z.number().int().nonnegative(), viewedMembers: z.number().int().nonnegative() }).strict()
  }).strict(),
  z.object({
    id: z.literal('global'),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    videoUrl: httpsUrl,
    revision: z.number().int().positive(),
    updatedBy: z.string().uuid().nullable(),
    updatedAt: publicFreeReportDateTimeSchema,
    audience: z.object({ eligibleMembers: z.number().int().nonnegative(), viewedMembers: z.number().int().nonnegative() }).strict()
  }).strict()
]);
export type AdminFreeMemberBenefitResponse = z.infer<typeof adminFreeMemberBenefitResponseSchema>;

export const adminFreeMemberBenefitItemSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  videoUrl: httpsUrl,
  revision: z.number().int().positive(),
  createdAt: publicFreeReportDateTimeSchema,
  updatedBy: z.string().uuid().nullable(),
  updatedAt: publicFreeReportDateTimeSchema,
  viewedMembers: z.number().int().nonnegative()
}).strict();
export const adminFreeMemberBenefitListResponseSchema = z.object({
  eligibleMembers: z.number().int().nonnegative(),
  items: z.array(adminFreeMemberBenefitItemSchema)
}).strict();
export type AdminFreeMemberBenefitListResponse = z.infer<typeof adminFreeMemberBenefitListResponseSchema>;

export const adminFreeReportAudioUploadResponseSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  contentType: z.enum(freeReportAudioContentTypes),
  sizeBytes: z.number().int().positive().max(8 * 1024 * 1024)
}).strict().refine(value => value.url === `/api/v1/free-report-audio/${value.id}`, { path: ['url'], message: '音声URLとIDが一致しません。' });
export type AdminFreeReportAudioUploadResponse = z.infer<typeof adminFreeReportAudioUploadResponseSchema>;

export const adminFreeReportDraftResponseSchema = z.object({
  id: z.string().uuid(),
  raceId: z.string().uuid(),
  upEntryId: z.string().uuid(),
  upReason: z.string(),
  downEntryId: z.string().uuid(),
  downReason: z.string(),
  audioUrl: z.string(),
  reviewText: z.string(),
  revision: z.number().int().positive(),
  updatedBy: z.string().uuid(),
  updatedAt: publicFreeReportDateTimeSchema
}).strict();
export type AdminFreeReportDraftResponse = z.infer<typeof adminFreeReportDraftResponseSchema>;

export const adminFreeReportPublishResponseSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  kind: z.enum(['PRE_RACE', 'POST_RACE_REVIEW']),
  publishedAt: publicFreeReportDateTimeSchema
}).strict();
export type AdminFreeReportPublishResponse = z.infer<typeof adminFreeReportPublishResponseSchema>;

export const freeReportDraftSchema = z.object({
  revision: z.number().int().min(0),
  upEntryId: z.string().uuid(),
  upReason: z.string().trim().min(1).max(1000),
  downEntryId: z.string().uuid(),
  downReason: z.string().trim().min(1).max(1000),
  audioUrl: audioSource,
  reviewText: z.string().trim().max(2000),
  reason: z.string().trim().min(1).max(500)
}).strict().refine(value => value.upEntryId !== value.downEntryId, { path: ['downEntryId'], message: '評価UP馬とDOWN馬は別の馬を選択してください。' });

export const freeReportPublishSchema = z.object({
  revision: z.number().int().positive(),
  kind: z.enum(['PRE_RACE', 'POST_RACE_REVIEW']),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const freeMemberBenefitSchema = z.object({
  revision: z.number().int().min(0),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  videoUrl: httpsUrl,
  reason: z.string().trim().min(1).max(500)
}).strict();

export const freeMemberBenefitCreateSchema = freeMemberBenefitSchema.omit({ revision: true });
