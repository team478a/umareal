import { z } from 'zod';

const optionalValue = (max: number, lowerCase = false) => z.string().trim().min(1).max(max).transform(value => lowerCase ? value.toLowerCase() : value).optional();

export const acquisitionSchema = z.object({
  source: optionalValue(100, true),
  medium: optionalValue(100, true),
  campaign: optionalValue(160),
  content: optionalValue(160),
  term: optionalValue(160),
  landingPath: z.string().trim().min(1).max(500).regex(/^\/(?!\/)[^?#]*$/).optional(),
  referralCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional()
}).strict();

export type AcquisitionInput = z.infer<typeof acquisitionSchema>;

export const acquisitionCampaignCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).transform(value => value.toLowerCase()),
  source: z.string().trim().min(1).max(100).transform(value => value.toLowerCase()),
  medium: z.string().trim().min(1).max(100).transform(value => value.toLowerCase()),
  content: z.string().trim().min(1).max(160).optional(),
  landingPath: z.string().trim().min(1).max(500).regex(/^\/(?!\/)[^?#]*$/).default('/register'),
  referralCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const acquisitionReportQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
