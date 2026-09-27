import { z } from 'zod';

const httpsUrl = z.string().trim().url().max(1000).refine(value => new URL(value).protocol === 'https:', 'HTTPSのURLを指定してください。');
const audioSource = z.string().trim().max(1000).refine(value => /^\/api\/v1\/free-report-audio\/[0-9a-f-]{36}$/.test(value) || (() => { try { return new URL(value).protocol === 'https:'; } catch { return false; } })(), '録音済み音声またはHTTPSのURLを指定してください。');

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
    videoUrl: httpsUrl,
    updatedAt: publicFreeReportDateTimeSchema
  }).strict()
]);
export type PublicFreeMemberBenefitResponse = z.infer<typeof publicFreeMemberBenefitResponseSchema>;

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
