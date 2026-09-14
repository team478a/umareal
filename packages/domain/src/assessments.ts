import { z } from 'zod';
export const metrics = ['body', 'walk', 'coat', 'focus', 'calm'] as const;
export const metricLabels = { body: '馬体の張り', walk: '歩様・踏み込み', coat: '毛艶', focus: '気合・集中力', calm: '発汗・落ち着き' };
export const changes = ['BIG_UP', 'UP', 'SAME', 'DOWN', 'BIG_DOWN', 'UNKNOWN'] as const;
export const changeLabels = { BIG_UP: '大幅UP', UP: 'UP', SAME: '据え置き', DOWN: 'DOWN', BIG_DOWN: '大幅DOWN', UNKNOWN: '判断不能' };
export const marks = ['NONE', 'HONMEI', 'TAIKO', 'TANANA', 'RENKA', 'ANA', 'DANGER'] as const;
export const markLabels = { NONE: '印なし', HONMEI: '◎ 本命', TAIKO: '○ 対抗', TANANA: '▲ 単穴', RENKA: '△ 連下', ANA: '☆ 穴', DANGER: '危険馬' };
// null = not entered, 0 = explicitly unable to assess.
const metric = z.number().int().min(0).max(5).nullable();
export const assessmentSchema = z.object({
  preScore: z.number().int().min(0).max(100).nullable(), preRank: z.number().int().min(1).max(18).nullable(),
  preMark: z.enum(marks).nullable(), preComment: z.string().max(1000),
  body: metric, walk: metric, coat: metric, focus: metric, calm: metric,
  change: z.enum(changes).nullable(), paddockComment: z.string().max(1000)
}).strict();
export type AssessmentInput = z.infer<typeof assessmentSchema>;
export const blankAssessment: AssessmentInput = { preScore: null, preRank: null, preMark: null, preComment: '', body: null, walk: null, coat: null, focus: null, calm: null, change: null, paddockComment: '' };
export function paddockComplete(value: AssessmentInput) { return metrics.every(key => value[key] !== null) && value.change !== null; }
export function preComplete(value: AssessmentInput) { return value.preScore !== null && value.preRank !== null && value.preMark !== null; }
export const assessmentSaveSchema = z.object({
  content: assessmentSchema, revision: z.number().int().min(0), raceRevision: z.number().int().positive(),
  horseId: z.string().uuid(), mutationId: z.string().uuid(), reason: z.string().trim().min(1).max(500)
}).strict();
