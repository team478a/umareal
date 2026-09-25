import { z } from 'zod';
import { acquisitionSchema } from './acquisition';
import { memberReferralCodeInputSchema } from './referrals';

export const lineOAuthStartSchema = z.object({ purpose: z.enum(['LOGIN', 'LINK', 'REGISTER']), acquisition: acquisitionSchema.optional(), memberReferralCode: memberReferralCodeInputSchema }).strict().superRefine((value, context) => {
  if (value.purpose !== 'REGISTER' && value.acquisition) context.addIssue({ code: 'custom', path: ['acquisition'], message: '流入情報は新規登録でのみ指定できます。' });
  if (value.purpose !== 'REGISTER' && value.memberReferralCode) context.addIssue({ code: 'custom', path: ['memberReferralCode'], message: '会員紹介コードは新規登録でのみ指定できます。' });
});
export type LineOAuthPurpose = z.infer<typeof lineOAuthStartSchema>['purpose'];

export const lineRegistrationSchema = z.object({
  token: z.string().min(32).max(128), displayName: z.string().trim().min(1).max(60),
  adult: z.literal(true), terms: z.literal(true), privacy: z.literal(true),
  termsVersion: z.literal('draft-v1'), privacyVersion: z.literal('draft-v1')
}).strict();

export const fallbackEmailSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(12).max(128)
}).strict();
