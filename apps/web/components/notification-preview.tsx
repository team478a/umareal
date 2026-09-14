'use client';
import { CheckCircle2, Clock3, Mail, MessageCircle, Users } from 'lucide-react';

export type NotificationPreviewData = {
  eventType: 'RACE_ANNOUNCED' | 'FREE_REPORT_PUBLISHED' | 'FREE_REPORT_REVIEW_PUBLISHED';
  contentLabel: string;
  kind?: 'PRE_RACE' | 'POST_RACE_REVIEW';
  draftRevision?: number;
  generatedAt: string;
  plannedAt: string;
  timing: 'IMMEDIATE' | 'SCHEDULED';
  version: number;
  race: { id: string; raceDate: string; venue: string; number: number; name: string; startsAt: string };
  audience: {
    uniqueMembers: number;
    totalDeliveries: number;
    duplicateChannelMembers: number;
    line: { enabled: boolean; eligibleRecipients: number; scheduledDeliveries: number };
    email: { enabled: boolean; eligibleRecipients: number; scheduledDeliveries: number };
  };
  message: { type: 'text'; text: string };
};

const format = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export function NotificationPreview({ preview, action, busy = false }: { preview: NotificationPreviewData; action?: { label: string; onClick: () => void }; busy?: boolean }) {
  const channels = [
    { key: 'line', label: 'LINE', Icon: MessageCircle, value: preview.audience.line },
    { key: 'email', label: 'メール', Icon: Mail, value: preview.audience.email }
  ] as const;
  return <section className="delivery-preview" aria-label={`${preview.race.name}の配信前確認`}>
    <div className="delivery-preview-heading"><div><span className="eyebrow">DELIVERY PREVIEW</span><h4>配信前確認</h4></div><span className="status-tag">{preview.contentLabel} 第{preview.version}版</span></div>
    <div className="delivery-preview-summary">
      <div><Users size={20} /><span>対象会員<strong>{preview.audience.uniqueMembers}人</strong></span></div>
      <div><CheckCircle2 size={20} /><span>予定配送<strong>{preview.audience.totalDeliveries}件</strong></span></div>
      <div><Clock3 size={20} /><span>{preview.timing === 'IMMEDIATE' ? '公開後すぐ' : '配信予定'}<strong>{format(preview.plannedAt)} JST</strong></span></div>
    </div>
    <div className="delivery-preview-channels">{channels.map(({ key, label, Icon, value }) => <div className={value.enabled ? 'enabled' : 'disabled'} key={key}><Icon size={18} /><span>{label}<small>{value.enabled ? `${value.scheduledDeliveries}件を配信予定` : `停止中・候補${value.eligibleRecipients}件`}</small></span></div>)}</div>
    {preview.audience.duplicateChannelMembers > 0 && <p className="muted delivery-preview-note">両方のチャネルで受け取る会員は{preview.audience.duplicateChannelMembers}人です。</p>}
    <div className="delivery-message"><span>送信本文</span><pre>{preview.message.text}</pre></div>
    <p className="muted delivery-preview-note">対象はこの画面を開いた時点の人数です。配信直前にも会員状態と通知設定を確認します。</p>
    {action && <button type="button" className="button delivery-preview-action" disabled={busy} onClick={action.onClick}>{busy ? '処理中…' : action.label}</button>}
    {preview.audience.totalDeliveries === 0 && <p className="notice error" role="alert">有効な配信チャネルと対象会員がありません。通知設定を確認してください。</p>}
  </section>;
}
