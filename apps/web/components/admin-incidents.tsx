'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, ClipboardCopy, RefreshCw, ShieldAlert } from 'lucide-react';

type Issue = { code: string; severity: 'CRITICAL' | 'WARNING' | 'INFO'; title: string; detail: string; action: string; href: string };
type IncidentResponse = { generatedAt: string; status: 'NORMAL' | 'DEGRADED' | 'INCIDENT'; counts: { critical: number; warning: number; total: number }; issues: Issue[]; publicMessage: string; monitoring: { failedDeliveries: number; delayedDeliveries: number; stuckDeliveries: number; unmatchedWebhooks24h: number; lastWebhookAt: string | null; lastWebhookOutcome: string | null; settingsUpdatedAt: string; newPurchasesEnabled: boolean } };
const statusLabels = { NORMAL: '正常', DEGRADED: '要確認', INCIDENT: '障害対応中' } as const;
const severityLabels = { CRITICAL: '重大', WARNING: '警告', INFO: '案内中' } as const;
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));

export function AdminIncidents({ role }: { role: string }) {
  const [data, setData] = useState<IncidentResponse | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [copied, setCopied] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { const response = await fetch('/api/v1/admin/incidents', { cache: 'no-store' }); const value = await response.json(); if (!response.ok) throw new Error(value.message ?? '障害状態を取得できませんでした。'); setData(value); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000); return () => window.clearInterval(timer); }, [load]);
  async function copyMessage() { if (!data) return; try { await navigator.clipboard.writeText(data.publicMessage); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { setError('案内文をコピーできませんでした。選択してコピーしてください。'); } }
  const runbook = [
    ['1', '検知内容を確認', '件数、発生範囲、直近の設定変更を確認します。'],
    ['2', '会員向けWeb公開を確認', 'LINE障害中もWeb上の公開情報を維持します。'],
    ['3', '影響を抑える', '必要な機能だけを理由付きで停止し、公開済みデータは変更しません。'],
    ['4', '原因を解消して復旧', '通知は失敗理由を確認し、復旧後に理由付きで再送します。'],
    ['5', '復旧を再確認', '運用ボード、通知履歴、監査ログを確認して案内を更新します。']
  ];
  return <><div className="page-heading"><span className="eyebrow">INCIDENT RESPONSE</span><h1>障害対応チェック</h1><p>現在の停止・遅延を検知し、初動から復旧確認までを順番に進めます。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {loading && !data ? <div className="panel loading" role="status">障害状態を確認中…</div> : data && <>
      <section className={`incident-hero ${data.status.toLowerCase()}`} aria-label={`システム状態 ${statusLabels[data.status]}`}><div className="incident-hero-icon">{data.status === 'NORMAL' ? <Check /> : <ShieldAlert />}</div><div><span>現在のシステム状態</span><h2>{statusLabels[data.status]}</h2><small>最終確認 {formatDate(data.generatedAt)} JST</small></div><div className="incident-totals"><strong>{data.counts.critical}<small>重大</small></strong><strong>{data.counts.warning}<small>警告</small></strong><strong>{data.counts.total}<small>全検知</small></strong></div><button className="button secondary small" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />再確認</button></section>
      <section className="incident-metrics" aria-label="障害監視指標">{[['通知失敗', data.monitoring.failedDeliveries], ['60秒超の待機', data.monitoring.delayedDeliveries], ['5分超の送信中', data.monitoring.stuckDeliveries], ['未照合Webhook', data.monitoring.unmatchedWebhooks24h]].map(([label, value]) => <div className="stat" key={label}><span>{label}</span><strong>{value}<small>件</small></strong></div>)}</section>
      <section className="panel"><div className="panel-heading"><div><h2>検知内容</h2><span className="muted">自動判定 · 秘密情報は表示しません</span></div></div>{data.issues.length ? <div className="incident-list">{data.issues.map(issue => <article className={`incident-item ${issue.severity.toLowerCase()}`} key={issue.code}><AlertTriangle size={20} /><div><span>{severityLabels[issue.severity]}</span><h3>{issue.title}</h3><p>{issue.detail}</p><small>{issue.action}</small></div>{issue.href === '/admin/settings' && role !== 'ADMIN' ? <b>管理者へ連絡</b> : <Link className="button secondary small" href={issue.href}>確認する</Link>}</article>)}</div> : <div className="empty incident-clear"><Check size={34} /><h3>対応が必要な障害はありません</h3><p>公開・通知・取込と通知キューに異常は検知されていません。</p></div>}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">RUNBOOK</span><h2>対応手順</h2></div></div><ol className="incident-runbook">{runbook.map(([number, title, detail]) => <li key={number}><b>{number}</b><div><strong>{title}</strong><small>{detail}</small></div></li>)}</ol><div className="incident-links"><Link className="button secondary small" href="/admin">運用ボード</Link><Link className="button secondary small" href="/admin/notifications">通知履歴</Link>{role === 'ADMIN' && <Link className="button secondary small" href="/admin/settings">緊急停止設定</Link>}{role === 'ADMIN' && <Link className="button secondary small" href="/admin/audit">監査ログ</Link>}</div></section>
      <section className="panel incident-message"><div className="panel-heading"><div><h2>会員向け案内文案</h2><span className="muted">内容を確認してから既存の案内手段で使用してください</span></div></div><div className="panel-body"><textarea aria-label="会員向け案内文案" readOnly value={data.publicMessage} rows={4} /><button className="button secondary small" onClick={() => void copyMessage()}><ClipboardCopy size={16} />{copied ? 'コピーしました' : '案内文をコピー'}</button></div></section>
    </>}
  </>;
}
