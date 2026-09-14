import { z } from 'zod';

const httpsUrl = z.string().trim().url().max(1000).refine(value => new URL(value).protocol === 'https:', 'HTTPSのURLを指定してください。');
const audioSource = z.string().trim().max(1000).refine(value => /^\/api\/v1\/free-report-audio\/[0-9a-f-]{36}$/.test(value) || (() => { try { return new URL(value).protocol === 'https:'; } catch { return false; } })(), '録音済み音声またはHTTPSのURLを指定してください。');

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
