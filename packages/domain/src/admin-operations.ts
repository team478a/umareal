import { z } from 'zod';
import { dateSchema, raceStatuses } from './races';

const adminOperationsDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminOperationsStepKeys = ['SETUP', 'ANNOUNCEMENT', 'PADDOCK', 'PUBLICATION', 'DELIVERY', 'RESULT'] as const;
export const adminOperationsStepStates = ['DONE', 'CURRENT', 'WAITING', 'BLOCKED', 'NOT_DUE'] as const;
export const adminOperationsAttentionCodes = ['DELIVERY_FAILED', 'SETUP_INCOMPLETE', 'ANNOUNCEMENT_PENDING', 'PADDOCK_INCOMPLETE', 'PUBLICATION_PENDING', 'PUBLICATION_DUE_SOON', 'PUBLICATION_OVERDUE', 'RESULT_PENDING'] as const;

export const adminOperationsStepSchema = z.object({
  key: z.enum(adminOperationsStepKeys),
  label: z.string().min(1),
  state: z.enum(adminOperationsStepStates),
  detail: z.string().min(1)
}).strict();

export const adminOperationsRaceSchema = z.object({
  id: z.string().uuid(),
  raceDate: dateSchema,
  venue: z.string().min(1),
  number: z.number().int().positive(),
  name: z.string().min(1),
  status: z.enum(raceStatuses),
  startsAt: adminOperationsDateTimeSchema,
  secondsRemaining: z.number().int(),
  deadlineState: z.enum(['UPCOMING', 'DUE_SOON', 'OVERDUE']),
  assignments: z.array(z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1),
    active: z.boolean()
  }).strict()),
  entries: z.object({
    total: z.number().int().nonnegative(),
    paddockCompleted: z.number().int().nonnegative()
  }).strict(),
  announcement: z.object({
    version: z.number().int().positive(),
    publishedAt: adminOperationsDateTimeSchema,
    eventStatus: z.string().min(1).nullable()
  }).strict().nullable(),
  prediction: z.object({
    version: z.number().int().positive(),
    status: z.enum(['PUBLISHED', 'CORRECTED']),
    publishedAt: adminOperationsDateTimeSchema,
    eventStatus: z.string().min(1).nullable()
  }).strict().nullable(),
  notification: z.object({
    queued: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative()
  }).strict(),
  result: z.object({
    version: z.number().int().positive(),
    confirmedAt: adminOperationsDateTimeSchema
  }).strict().nullable(),
  warnings: z.array(z.string().min(1)),
  rehearsal: z.object({
    status: z.enum(['BLOCKED', 'COMPLETE', 'READY', 'IN_PROGRESS']),
    done: z.number().int().min(0).max(6),
    total: z.literal(6),
    nextStep: z.enum(adminOperationsStepKeys).nullable(),
    steps: z.array(adminOperationsStepSchema).length(6)
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.entries.paddockCompleted > value.entries.total) {
    context.addIssue({ code: 'custom', path: ['entries', 'paddockCompleted'], message: 'Paddock completion count exceeds the entry total.' });
  }
  const keys = value.rehearsal.steps.map(step => step.key);
  if (keys.some((key, index) => key !== adminOperationsStepKeys[index])) {
    context.addIssue({ code: 'custom', path: ['rehearsal', 'steps'], message: 'Rehearsal steps are out of order.' });
  }
});

export const adminOperationsResponseSchema = z.object({
  date: dateSchema,
  generatedAt: adminOperationsDateTimeSchema,
  items: z.array(adminOperationsRaceSchema),
  alerts: z.number().int().nonnegative(),
  attention: z.object({
    critical: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    items: z.array(z.object({
      raceId: z.string().uuid(),
      code: z.enum(adminOperationsAttentionCodes),
      severity: z.enum(['CRITICAL', 'WARNING']),
      title: z.string().min(1),
      detail: z.string().min(1),
      href: z.string().startsWith('/')
    }).strict())
  }).strict().superRefine((value, context) => {
    const critical = value.items.filter(item => item.severity === 'CRITICAL').length;
    const warning = value.items.filter(item => item.severity === 'WARNING').length;
    if (critical !== value.critical) context.addIssue({ code: 'custom', path: ['critical'], message: 'Critical attention count does not match items.' });
    if (warning !== value.warning) context.addIssue({ code: 'custom', path: ['warning'], message: 'Warning attention count does not match items.' });
  }),
  rehearsal: z.object({
    ready: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    preflight: z.object({
      csvImportEnabled: z.boolean(),
      predictionPublicationEnabled: z.boolean(),
      lineAvailable: z.boolean(),
      lineNotificationsEnabled: z.boolean(),
      lineConfigured: z.boolean()
    }).strict()
  }).strict()
}).strict();

export type AdminOperationsResponse = z.infer<typeof adminOperationsResponseSchema>;
export type AdminOperationsRace = z.infer<typeof adminOperationsRaceSchema>;
export type AdminOperationsStep = z.infer<typeof adminOperationsStepSchema>;
export type AdminOperationsAttention = AdminOperationsResponse['attention']['items'][number];

export function buildAdminOperationsAttention(items: AdminOperationsRace[]): AdminOperationsResponse['attention'] {
  const attentionItems = items.flatMap(item => {
    const raceLabel = `${item.venue}${item.number}R`;
    const attention: AdminOperationsAttention[] = [];
    if (item.notification.failed > 0) attention.push({ raceId: item.id, code: 'DELIVERY_FAILED', severity: 'CRITICAL', title: `${raceLabel} 通知失敗`, detail: `${item.notification.failed}件の通知が失敗しています。原因確認後に再送してください。`, href: '/admin/notifications' });
    const urgent = item.deadlineState !== 'UPCOMING';
    const activeAssignment = item.assignments.some(assignment => assignment.active);
    if (!activeAssignment || item.entries.total === 0) {
      attention.push({ raceId: item.id, code: 'SETUP_INCOMPLETE', severity: urgent ? 'CRITICAL' : 'WARNING', title: `${raceLabel} レース準備未完了`, detail: !activeAssignment ? '有効な担当者が設定されていません。' : '出走馬が登録されていません。', href: '/admin/races' });
    } else if (!item.announcement) {
      attention.push({ raceId: item.id, code: 'ANNOUNCEMENT_PENDING', severity: urgent ? 'CRITICAL' : 'WARNING', title: `${raceLabel} 対象レース未告知`, detail: '無料会員への対象レース告知を確認してください。', href: '/admin/publication-schedules' });
    } else if (item.entries.paddockCompleted < item.entries.total) {
      attention.push({ raceId: item.id, code: 'PADDOCK_INCOMPLETE', severity: urgent ? 'CRITICAL' : 'WARNING', title: `${raceLabel} パドック評価未完了`, detail: `${item.entries.total - item.entries.paddockCompleted}頭の評価が未完了です。`, href: `/expert?race=${item.id}` });
    } else if (!item.prediction) {
      const code = item.deadlineState === 'OVERDUE' ? 'PUBLICATION_OVERDUE' : item.deadlineState === 'DUE_SOON' ? 'PUBLICATION_DUE_SOON' : 'PUBLICATION_PENDING';
      const title = item.deadlineState === 'OVERDUE' ? `${raceLabel} 最終予想が期限超過` : item.deadlineState === 'DUE_SOON' ? `${raceLabel} 最終予想の公開が接近` : `${raceLabel} 最終予想の公開待ち`;
      const detail = item.deadlineState === 'OVERDUE' ? '発走時刻を経過しています。公開可否と運用記録を確認してください。' : item.deadlineState === 'DUE_SOON' ? `発走まで${Math.max(1, Math.ceil(item.secondsRemaining / 60))}分です。プレビューと公開を完了してください。` : 'パドック評価が完了しています。プレビューと公開を確認してください。';
      attention.push({ raceId: item.id, code, severity: urgent ? 'CRITICAL' : 'WARNING', title, detail, href: `/expert?race=${item.id}` });
    } else if (item.secondsRemaining <= 0 && !item.result && item.status !== 'CANCELLED') {
      attention.push({ raceId: item.id, code: 'RESULT_PENDING', severity: 'WARNING', title: `${raceLabel} 結果未確定`, detail: '着順を確認し、公開版に対する結果を確定してください。', href: '/admin/results' });
    }
    return attention;
  }).sort((left, right) => Number(right.severity === 'CRITICAL') - Number(left.severity === 'CRITICAL'));
  return {
    critical: attentionItems.filter(item => item.severity === 'CRITICAL').length,
    warning: attentionItems.filter(item => item.severity === 'WARNING').length,
    items: attentionItems
  };
}
