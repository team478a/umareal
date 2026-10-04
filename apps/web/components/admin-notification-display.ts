import type { AdminNotificationDelivery } from '@keiba/domain';

type NotificationEvent = AdminNotificationDelivery['event'];

export type AdminNotificationDisplay = {
  title: string;
  detail: string;
  targetDate: string;
};

export function adminNotificationDisplay(event: NotificationEvent): AdminNotificationDisplay {
  if (event.contentVersion) return { title: event.contentVersion.title, detail: `${event.contentVersion.kind === 'ARTICLE' ? '記事' : event.contentVersion.kind === 'VIDEO' ? '動画' : '音声'} 第${event.contentVersion.version}版 · ${event.contentVersion.visibility}`, targetDate: event.contentVersion.category };
  if (event.paperVersion) return { title: event.paperVersion.title, detail: `通常レース紙面 第${event.paperVersion.version}版`, targetDate: event.paperVersion.targetDate };
  const billing = event.billingEvent;
  if (billing) {
    const title = billing.subscription?.planCode === 'FOUNDER'
      ? '創設会員'
      : billing.subscription?.planCode === 'STANDARD'
        ? '通常月額会員'
        : `${billing.dayPass?.raceDate ?? ''} 1日利用`;
    return { title, detail: `課金通知 · ${billing.eventType}`, targetDate: '会員本人宛て' };
  }

  if (event.win5EvaluationVersion) return {
    title: event.win5EvaluationVersion.product.title,
    detail: `WIN5評価結果 第${event.win5EvaluationVersion.version}版`,
    targetDate: event.win5EvaluationVersion.product.targetDate
  };
  if (event.raceResultVersion) return {
    title: `${event.raceResultVersion.race.venue} ${event.raceResultVersion.race.number}R ${event.raceResultVersion.race.name}`,
    detail: `パドック評価結果 第${event.raceResultVersion.version}版`,
    targetDate: event.raceResultVersion.race.raceDate
  };
  if (event.productVersion) return {
    title: event.productVersion.product.title,
    detail: `WIN5紙面 第${event.productVersion.version}版 · ${event.productVersion.accessScope}`,
    targetDate: event.productVersion.product.targetDate
  };
  if (event.announcement) return {
    title: `${event.announcement.race.venue} ${event.announcement.race.number}R ${event.announcement.race.name}`,
    detail: `対象レース告知 第${event.announcement.version}版`,
    targetDate: event.announcement.race.raceDate
  };
  if (event.freeReportVersion) return {
    title: `${event.freeReportVersion.race.venue} ${event.freeReportVersion.race.number}R ${event.freeReportVersion.race.name}`,
    detail: `${event.freeReportVersion.kind === 'PRE_RACE' ? '無料速報' : 'レース後検証'} 第${event.freeReportVersion.version}版`,
    targetDate: event.freeReportVersion.race.raceDate
  };
  if (event.version) return {
    title: `${event.version.prediction.race.venue} ${event.version.prediction.race.number}R ${event.version.prediction.race.name}`,
    detail: `予想 第${event.version.version}版 · ${event.version.visibility}`,
    targetDate: event.version.prediction.race.raceDate
  };
  if (event.eventType === 'SUPPORT_RESPONSE_POSTED') return {
    title: 'お問い合わせへの回答',
    detail: '会員への回答通知',
    targetDate: '会員本人宛て'
  };
  return { title: '会員向け通知', detail: event.eventType, targetDate: '会員本人宛て' };
}
