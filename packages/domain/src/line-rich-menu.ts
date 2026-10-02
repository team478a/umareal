import { z } from 'zod';

const dateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const lineRichMenuItems = [
  { key: 'BENEFIT', label: '登録特典', description: 'LINE登録特典動画', path: '/benefit' },
  { key: 'WIN5', label: 'WIN5紙面', description: '前日のWIN5紙面', path: '/win5' },
  { key: 'RACES', label: 'レース一覧', description: '公開レースを確認', path: '/races' },
  { key: 'NOTIFICATIONS', label: 'お知らせ', description: '告知と公開情報', path: '/notifications' },
  { key: 'PLANS', label: '料金プラン', description: 'プランと料金を確認', path: '/plans' },
  { key: 'ACCOUNT', label: 'マイページ', description: '会員情報と設定', path: '/account' }
] as const;

const lineRichMenuItemSchema = z.object({
  key: z.enum(['BENEFIT', 'WIN5', 'RACES', 'NOTIFICATIONS', 'PLANS', 'ACCOUNT']),
  label: z.string().min(1).max(40),
  description: z.string().min(1).max(100),
  path: z.enum(['/benefit', '/win5', '/races', '/notifications', '/plans', '/account']),
  url: z.string().url()
}).strict();

const lineRichMenuPublicationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['PUBLISHING', 'PUBLISHED', 'FAILED']),
  providerRichMenuId: z.string().max(300).nullable(),
  imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  imageBytes: z.number().int().positive().max(1_048_576),
  reason: z.string().min(1).max(500),
  createdAt: dateTimeSchema,
  completedAt: dateTimeSchema.nullable(),
  errorCode: z.string().max(100).nullable()
}).strict();

export const adminLineRichMenuResponseSchema = z.object({
  transport: z.enum(['TEST_ONLY', 'LINE', 'UNAVAILABLE']),
  credentialsConfigured: z.boolean(),
  menu: z.object({
    width: z.literal(2500),
    height: z.literal(1686),
    chatBarText: z.literal('メニューを開く'),
    items: z.array(lineRichMenuItemSchema).length(6)
  }).strict(),
  currentPublication: lineRichMenuPublicationSchema.nullable(),
  attempts: z.array(lineRichMenuPublicationSchema).max(10)
}).strict();
export type AdminLineRichMenuResponse = z.infer<typeof adminLineRichMenuResponseSchema>;

export const publishLineRichMenuSchema = z.object({
  currentPublicationId: z.string().uuid().nullable(),
  reason: z.string().trim().min(1).max(500)
}).strict();
export type PublishLineRichMenuInput = z.infer<typeof publishLineRichMenuSchema>;

export const publishLineRichMenuResponseSchema = z.object({
  publication: lineRichMenuPublicationSchema,
  transport: z.enum(['TEST_ONLY', 'LINE'])
}).strict();
export type PublishLineRichMenuResponse = z.infer<typeof publishLineRichMenuResponseSchema>;

export const lineLoginReturnPathSchema = z.enum(['/papers', '/account', '/benefit', '/win5', '/races', '/notifications', '/plans']);
export type LineLoginReturnPath = z.infer<typeof lineLoginReturnPathSchema>;
