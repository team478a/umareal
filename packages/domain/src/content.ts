import { z } from 'zod';

export const contentKinds = ['ARTICLE', 'VIDEO', 'AUDIO'] as const;
export const contentStatuses = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const;
export const contentVisibilities = ['PUBLIC', 'MEMBERS', 'PAID'] as const;

const dateTime = z.preprocess(value => value instanceof Date ? value.toISOString() : value, z.string().datetime({ offset: true }));
const safeText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum)
  .refine(value => !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 && code !== 9 && code !== 10 && code !== 13; }), '制御文字は使用できません。');
const httpsUrl = z.string().trim().url().max(1000).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}, 'HTTPSのURLを指定してください。');

export const contentDraftSchema = z.object({
  kind: z.enum(contentKinds),
  title: safeText(1, 160),
  summary: safeText(1, 500),
  body: safeText(1, 20000),
  thumbnailUrl: httpsUrl.nullable(),
  mediaUrl: httpsUrl.nullable(),
  category: safeText(1, 80),
  tags: z.array(safeText(1, 30)).max(10).refine(values => new Set(values).size === values.length, 'タグは重複できません。'),
  visibility: z.enum(contentVisibilities)
}).strict().superRefine((value, context) => {
  if (value.kind === 'ARTICLE' && value.mediaUrl) context.addIssue({ code: 'custom', path: ['mediaUrl'], message: '記事には動画・音声URLを設定できません。' });
  if (value.kind !== 'ARTICLE' && !value.mediaUrl) context.addIssue({ code: 'custom', path: ['mediaUrl'], message: '動画・音声にはHTTPSの配信URLが必要です。' });
});

export type ContentDraft = z.infer<typeof contentDraftSchema>;

export const contentSaveSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative(), draft: contentDraftSchema,
  reason: safeText(1, 500)
}).strict();

export const contentPublishSchema = z.object({ revision: z.number().int().positive(), reason: safeText(1, 500) }).strict();
export const contentScheduleSchema = contentPublishSchema.extend({ scheduledAt: z.string().datetime({ offset: true }) }).strict();
export const contentStateChangeSchema = contentPublishSchema;

const contentMetadataSchema = z.object({
  id: z.string().uuid(), version: z.number().int().positive(), kind: z.enum(contentKinds), title: z.string(), summary: z.string(),
  thumbnailUrl: z.string().nullable(), category: z.string(), tags: z.array(z.string()), visibility: z.enum(contentVisibilities), publishedAt: dateTime
}).strict();

const adminContentItemSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), status: z.enum(contentStatuses), isVisible: z.boolean(), draft: contentDraftSchema,
  scheduledAt: dateTime.nullable(), scheduleError: z.string().nullable(), createdAt: dateTime, updatedAt: dateTime,
  versions: z.array(contentMetadataSchema).max(50)
}).strict();

export const adminContentListResponseSchema = z.object({ items: z.array(adminContentItemSchema).max(100) }).strict();
export const adminContentItemResponseSchema = adminContentItemSchema;
export const adminContentMutationResponseSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), status: z.enum(contentStatuses), scheduledAt: dateTime.nullable(), version: z.number().int().positive().optional() }).strict();

export const publicContentListResponseSchema = z.object({
  items: z.array(contentMetadataSchema.extend({ locked: z.boolean() }).strict()).max(20),
  total: z.number().int().nonnegative(), page: z.number().int().positive(), limit: z.literal(20),
  filters: z.object({ kind: z.enum(['ALL', ...contentKinds]), category: z.string().nullable(), categories: z.array(z.string()) }).strict()
}).strict();

export const publicContentDetailResponseSchema = z.discriminatedUnion('locked', [
  contentMetadataSchema.extend({ locked: z.literal(true) }).strict(),
  contentMetadataSchema.extend({ locked: z.literal(false), body: z.string(), mediaUrl: z.string().nullable() }).strict()
]);

export type AdminContentListResponse = z.infer<typeof adminContentListResponseSchema>;
export type AdminContentItemResponse = z.infer<typeof adminContentItemResponseSchema>;
export type AdminContentMutationResponse = z.infer<typeof adminContentMutationResponseSchema>;
export type PublicContentListResponse = z.infer<typeof publicContentListResponseSchema>;
export type PublicContentDetailResponse = z.infer<typeof publicContentDetailResponseSchema>;
