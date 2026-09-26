import { z } from 'zod';
import { acquisitionSchema } from './acquisition';
import { consentVersions } from './legal';
import { memberReferralCodeInputSchema } from './referrals';
export * from './races';
export * from './assessments';
export * from './predictions';
export * from './admin-settings';
export * from './notifications';
export * from './line';
export * from './acquisition';
export * from './line-login';
export * from './results';
export * from './billing';
export * from './billing-support';
export * from './support';
export * from './free-report';
export * from './publication-schedule';
export * from './legal';
export * from './launch';
export * from './operational-alert';
export * from './win5';
export * from './win5-results';
export * from './evaluations';
export * from './social-shares';
export * from './staff';
export * from './referrals';
export * from './deployment';
export * from './readiness';

export const roles = ['MEMBER', 'EXPERT', 'EDITOR', 'OPERATOR', 'ADMIN'] as const;
export type Role = typeof roles[number];
export type Identity = { id: string; role: Role; aal: 1 | 2 };
export const registrationSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(60),
  adult: z.literal(true), terms: z.literal(true), privacy: z.literal(true),
  termsVersion: z.literal(consentVersions.terms), privacyVersion: z.literal(consentVersions.privacy),
  acquisition: acquisitionSchema.optional(),
  memberReferralCode: memberReferralCodeInputSchema,
  captchaToken: z.string().trim().min(1).max(2048).optional()
}).strict();
export const loginSchema = z.object({ email: z.string().trim().email().transform(v => v.toLowerCase()), password: z.string().max(128) }).strict();
export const preferencesSchema = z.object({ emailEnabled: z.boolean().optional(), predictions: z.boolean(), changes: z.boolean(), articles: z.boolean(), billing: z.boolean() }).strict();
export const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export function requiresMfa(role: Role) { return role === 'ADMIN' || role === 'EXPERT'; }
export function canManage(identity: Identity, accepted: readonly Role[]) {
  return accepted.includes(identity.role) && (!requiresMfa(identity.role) || identity.aal === 2);
}
export function canEditRace(identity: Identity, assignedUserIds: readonly string[]) {
  return (identity.role === 'ADMIN' && identity.aal === 2) ||
    (identity.role === 'EXPERT' && identity.aal === 2 && assignedUserIds.includes(identity.id));
}
export type Entitlement = { startsAt: Date; endsAt: Date; revokedAt: Date | null; raceDate: string | null };
export function jstDate(date: Date) { return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
export function canReadPrediction(input: { now: Date; publishedAt: Date | null; visibility: 'FREE' | 'PAID'; raceDate: string; entitlements: Entitlement[] }) {
  if (!input.publishedAt || input.publishedAt > input.now) return false;
  if (input.visibility === 'FREE') return true;
  return input.entitlements.some(e => !e.revokedAt && e.startsAt <= input.now && input.now < e.endsAt && (!e.raceDate || e.raceDate === input.raceDate));
}
export function dayPassWindow(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
  const start = new Date(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(start.getTime()) || jstDate(start) !== date) throw new Error('Invalid date');
  return { startsAt: start, endsAt: new Date(start.getTime() + 86400000) };
}
