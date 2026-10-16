import { z } from 'zod';
import { dateSchema } from './races';

const dateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const bankTransferAccountSchema = z.object({
  bankName: z.string().trim().min(1).max(100),
  branchName: z.string().trim().min(1).max(100),
  accountType: z.enum(['普通', '当座']),
  accountNumber: z.string().regex(/^\d{1,12}$/),
  accountHolder: z.string().trim().min(1).max(100),
  instructions: z.string().trim().max(1000)
}).strict();

const bankTransferSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  bankName: z.string().trim().max(100),
  branchName: z.string().trim().max(100),
  accountType: z.enum(['', '普通', '当座']),
  accountNumber: z.string().regex(/^\d{0,12}$/),
  accountHolder: z.string().trim().max(100),
  instructions: z.string().trim().max(1000),
  requestValidityDays: z.number().int().min(1).max(30),
  monthlyAccessDays: z.number().int().min(1).max(366)
}).strict();

function validateEnabledSettings(value: z.infer<typeof bankTransferSettingsBaseSchema>, context: z.RefinementCtx) {
  if (!value.enabled) return;
  for (const field of ['bankName', 'branchName', 'accountNumber', 'accountHolder'] as const) {
    if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: '銀行振込を有効にする場合は必須です。' });
  }
  if (!value.accountType) context.addIssue({ code: 'custom', path: ['accountType'], message: '口座種別を選択してください。' });
}

export const bankTransferSettingsSchema = bankTransferSettingsBaseSchema.superRefine(validateEnabledSettings);
export const bankTransferSettingsResponseSchema = bankTransferSettingsBaseSchema.extend({ revision: z.number().int().positive() }).strict().superRefine(validateEnabledSettings);

export const bankTransferSettingsUpdateSchema = bankTransferSettingsBaseSchema.extend({
  revision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine(validateEnabledSettings);

export const bankTransferCreateSchema = z.object({
  planCode: z.enum(['FOUNDER', 'STANDARD', 'DAY_PASS']),
  raceDate: dateSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.planCode === 'DAY_PASS' && !value.raceDate) context.addIssue({ code: 'custom', path: ['raceDate'], message: '1日利用の開催日を指定してください。' });
  if (value.planCode !== 'DAY_PASS' && value.raceDate) context.addIssue({ code: 'custom', path: ['raceDate'], message: '月額相当の申込に開催日は指定できません。' });
});

export const bankTransferReportSchema = z.object({
  payerName: z.string().trim().min(1).max(100),
  revision: z.number().int().positive()
}).strict();

export const bankTransferReviewSchema = z.object({
  action: z.enum(['CONFIRM', 'REJECT']),
  receivedAmountYen: z.number().int().positive().optional(),
  receivedAt: dateTimeSchema.optional(),
  revision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine((value, context) => {
  if (value.action === 'CONFIRM' && value.receivedAmountYen === undefined) context.addIssue({ code: 'custom', path: ['receivedAmountYen'], message: '着金額を入力してください。' });
  if (value.action === 'CONFIRM' && value.receivedAt === undefined) context.addIssue({ code: 'custom', path: ['receivedAt'], message: '着金日時を入力してください。' });
  if (value.action === 'REJECT' && (value.receivedAmountYen !== undefined || value.receivedAt !== undefined)) context.addIssue({ code: 'custom', message: '却下時に着金情報は指定できません。' });
});

export const bankTransferStatusSchema = z.enum(['AWAITING_TRANSFER', 'TRANSFER_REPORTED', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED']);

export const bankTransferRequestSchema = z.object({
  id: z.string().uuid(),
  planCode: z.enum(['FOUNDER', 'STANDARD', 'DAY_PASS']),
  raceDate: dateSchema.nullable(),
  amountYen: z.number().int().positive(),
  referenceCode: z.string().regex(/^UM-[A-Z0-9]{10}$/),
  status: bankTransferStatusSchema,
  payerName: z.string().nullable(),
  expiresAt: dateTimeSchema,
  reportedAt: dateTimeSchema.nullable(),
  receivedAt: dateTimeSchema.nullable(),
  confirmedAt: dateTimeSchema.nullable(),
  rejectedAt: dateTimeSchema.nullable(),
  reviewReason: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: dateTimeSchema,
  bankAccount: bankTransferAccountSchema
}).strict();

export const bankTransferCreateResponseSchema = bankTransferRequestSchema;
export const bankTransferReportResponseSchema = bankTransferRequestSchema;
export const bankTransferReviewResponseSchema = bankTransferRequestSchema;

export const adminBankTransferRequestSchema = bankTransferRequestSchema.extend({
  user: z.object({ displayName: z.string(), email: z.string().email().nullable() }).strict()
}).strict();

export type BankTransferSettings = z.infer<typeof bankTransferSettingsSchema>;
export type BankTransferSettingsResponse = z.infer<typeof bankTransferSettingsResponseSchema>;
export type BankTransferRequest = z.infer<typeof bankTransferRequestSchema>;
export type AdminBankTransferRequest = z.infer<typeof adminBankTransferRequestSchema>;
