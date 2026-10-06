import { Inject, Injectable } from '@nestjs/common';
import {
  adminOperationsRaceSchema,
  adminOperationsResponseSchema,
  assessmentSchema,
  buildAdminOperationsAttention,
  launchCapabilities,
  paddockComplete,
  resolveLaunchMode,
} from '@keiba/domain';
import type { AdminOperationsResponse } from '@keiba/domain';
import { DbService } from './db.service';
import { lineNotificationState } from './line-notification-policy';

@Injectable()
export class AdminOperationsQueryService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async get(date: string, now = new Date()): Promise<AdminOperationsResponse> {
    const [races, settings] = await Promise.all([
      this.db.race.findMany({
        where: { raceDate: date },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          raceDate: true,
          venue: true,
          number: true,
          name: true,
          status: true,
          startsAt: true,
          assignments: { select: { user: { select: { id: true, displayName: true, disabledAt: true } } } },
          entries: { where: { status: 'ACTIVE' }, orderBy: { number: 'asc' }, select: { assessment: { select: { content: true } } } },
          announcements: { orderBy: { version: 'desc' }, take: 1, select: { version: true, publishedAt: true, notificationEvent: { select: { status: true, deliveries: { select: { status: true } } } } } },
          prediction: { select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, status: true, publishedAt: true, notificationEvent: { select: { status: true, deliveries: { select: { status: true } } } } } } } },
          resultVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, confirmedAt: true } },
        },
      }),
      this.db.systemSetting.findUniqueOrThrow({
        where: { id: 'global' },
        select: {
          csvImportEnabled: true,
          predictionPublicationEnabled: true,
          lineNotificationsEnabled: true,
          lineChannelId: true,
          lineChannelSecretEncrypted: true,
          lineAccessTokenEncrypted: true,
        },
      }),
    ]);
    const lineAvailable = launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).lineNotifications;
    const lineConfigured = ['line', 'test'].includes(process.env.NOTIFICATION_TRANSPORT ?? '')
      && !!settings.lineChannelId
      && !!settings.lineChannelSecretEncrypted
      && !!settings.lineAccessTokenEncrypted;
    const lineState = lineNotificationState({ available: lineAvailable, enabled: settings.lineNotificationsEnabled, configured: lineConfigured });
    const items = races.map(race => {
      const completed = race.entries.filter(entry => {
        const parsed = assessmentSchema.safeParse(entry.assessment?.content);
        return parsed.success && paddockComplete(parsed.data);
      }).length;
      const announcement = race.announcements[0] ?? null;
      const prediction = race.prediction?.versions[0] ?? null;
      const deliveries = [announcement?.notificationEvent, prediction?.notificationEvent].flatMap(event => event?.deliveries ?? []);
      const notification = {
        queued: deliveries.filter(item => ['QUEUED', 'SENDING', 'RETRIED'].includes(item.status)).length,
        sent: deliveries.filter(item => item.status === 'SENT').length,
        failed: deliveries.filter(item => item.status === 'FAILED').length,
      };
      const secondsRemaining = Math.floor((race.startsAt.getTime() - now.getTime()) / 1000);
      const warnings: string[] = [];
      if (!race.assignments.length) warnings.push('担当者未設定');
      if (!race.entries.length) warnings.push('出走馬未登録');
      if (!announcement) warnings.push('対象レース未告知');
      if (race.entries.length && completed === 0) warnings.push('パドック未着手');
      else if (completed < race.entries.length) warnings.push(`パドック未完了 ${race.entries.length - completed}頭`);
      if (!prediction) warnings.push(secondsRemaining <= 0 ? '最終予想が期限超過' : '最終予想未公開');
      if (notification.failed) warnings.push(`通知失敗 ${notification.failed}件`);
      if (secondsRemaining <= 0 && prediction && !race.resultVersions.length && race.status !== 'CANCELLED') warnings.push('結果未確定');
      const activeAssignment = race.assignments.some(item => !item.user.disabledAt);
      const setupDone = activeAssignment && race.entries.length > 0;
      const paddockDone = race.entries.length > 0 && completed === race.entries.length;
      const predictionDeliveries = prediction?.notificationEvent?.deliveries ?? [];
      const predictionQueued = predictionDeliveries.some(item => ['QUEUED', 'SENDING', 'RETRIED'].includes(item.status));
      const notificationFailed = notification.failed > 0;
      const predictionSent = predictionDeliveries.some(item => item.status === 'SENT');
      const steps: { key: 'SETUP' | 'ANNOUNCEMENT' | 'PADDOCK' | 'PUBLICATION' | 'DELIVERY' | 'RESULT'; label: string; state: 'DONE' | 'CURRENT' | 'WAITING' | 'BLOCKED' | 'NOT_DUE'; detail: string }[] = [
        { key: 'SETUP', label: 'レース準備', state: setupDone ? 'DONE' : 'CURRENT', detail: !activeAssignment ? '有効な担当者を設定してください' : !race.entries.length ? '出走馬を登録してください' : `${race.entries.length}頭・担当者設定済み` },
        { key: 'ANNOUNCEMENT', label: '対象レース告知', state: announcement ? 'DONE' : setupDone ? 'CURRENT' : 'WAITING', detail: announcement ? `公開済み v${announcement.version}` : '無料会員へ対象レースを告知します' },
        { key: 'PADDOCK', label: 'パドック評価', state: paddockDone ? 'DONE' : !setupDone || !announcement ? 'WAITING' : 'CURRENT', detail: `${completed}/${race.entries.length}頭完了` },
        { key: 'PUBLICATION', label: '最終予想公開', state: prediction ? 'DONE' : !settings.predictionPublicationEnabled || secondsRemaining <= 0 ? 'BLOCKED' : !paddockDone ? 'WAITING' : 'CURRENT', detail: prediction ? `公開済み v${prediction.version}` : !settings.predictionPublicationEnabled ? '予想公開が緊急停止中です' : secondsRemaining <= 0 ? '公開締切を経過しています' : 'プレビュー確認後に公開します' },
        { key: 'DELIVERY', label: '通知確認', state: notificationFailed ? 'BLOCKED' : predictionQueued ? 'CURRENT' : predictionSent || prediction?.notificationEvent?.status === 'SKIPPED' ? 'DONE' : prediction && (lineState.paused || lineState.configurationMissing) ? 'BLOCKED' : prediction ? 'CURRENT' : 'WAITING', detail: notificationFailed ? '失敗した告知・予想配送を確認してください' : predictionQueued ? '通知処理を待っています' : predictionSent ? '送信済みです' : prediction?.notificationEvent?.status === 'SKIPPED' ? '通知対象なしとして処理済みです' : !lineAvailable ? 'LINE通知はこの公開モードでは対象外です。Web掲載とメール通知を確認します' : lineState.paused ? 'LINE通知が緊急停止中です' : lineState.configurationMissing ? 'LINE通知設定が未完了です' : '通知イベントを確認します' },
        { key: 'RESULT', label: '結果確定', state: race.resultVersions.length ? 'DONE' : secondsRemaining > 0 ? 'NOT_DUE' : prediction ? 'CURRENT' : 'WAITING', detail: race.resultVersions.length ? `確定済み v${race.resultVersions[0].version}` : secondsRemaining > 0 ? '発走後に確認します' : '着順を確認して評価結果を確定します' },
      ];
      const blocking = steps.filter(step => step.state === 'BLOCKED').length;
      const done = steps.filter(step => step.state === 'DONE').length;
      const actionable = steps.find(step => step.state === 'BLOCKED' || step.state === 'CURRENT') ?? null;
      const rehearsalStatus = blocking ? 'BLOCKED' : done === steps.length ? 'COMPLETE' : steps[5].state === 'NOT_DUE' && steps.slice(0, 5).every(step => step.state === 'DONE') ? 'READY' : 'IN_PROGRESS';
      return {
        id: race.id,
        raceDate: race.raceDate,
        venue: race.venue,
        number: race.number,
        name: race.name,
        status: race.status,
        startsAt: race.startsAt,
        secondsRemaining,
        deadlineState: secondsRemaining <= 0 ? 'OVERDUE' : secondsRemaining <= 1800 ? 'DUE_SOON' : 'UPCOMING',
        assignments: race.assignments.map(item => ({ id: item.user.id, displayName: item.user.displayName, active: !item.user.disabledAt })),
        entries: { total: race.entries.length, paddockCompleted: completed },
        announcement: announcement ? { version: announcement.version, publishedAt: announcement.publishedAt, eventStatus: announcement.notificationEvent?.status ?? null } : null,
        prediction: prediction ? { version: prediction.version, status: prediction.status, publishedAt: prediction.publishedAt, eventStatus: prediction.notificationEvent?.status ?? null } : null,
        notification,
        result: race.resultVersions[0] ?? null,
        warnings,
        rehearsal: { status: rehearsalStatus, done, total: steps.length, nextStep: actionable?.key ?? null, steps },
      };
    });
    const validatedItems = items.map(item => adminOperationsRaceSchema.parse(item));
    const attention = buildAdminOperationsAttention(validatedItems);
    return adminOperationsResponseSchema.parse({
      date,
      generatedAt: now,
      items: validatedItems,
      alerts: validatedItems.reduce((sum, item) => sum + item.warnings.length, 0),
      attention,
      rehearsal: {
        ready: validatedItems.filter(item => ['READY', 'COMPLETE'].includes(item.rehearsal.status)).length,
        blocked: validatedItems.filter(item => item.rehearsal.status === 'BLOCKED').length,
        total: validatedItems.length,
        preflight: {
          csvImportEnabled: settings.csvImportEnabled,
          predictionPublicationEnabled: settings.predictionPublicationEnabled,
          lineAvailable,
          lineNotificationsEnabled: settings.lineNotificationsEnabled,
          lineConfigured,
        },
      },
    });
  }
}
