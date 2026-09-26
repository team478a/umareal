'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, CircleHelp, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AdminReadinessCheck, AdminReadinessResponse } from '@keiba/domain';

type CheckStatus = AdminReadinessCheck['status'];

const groups: Array<[AdminReadinessCheck['group'], string, string]> = [
  ['APPLICATION', '基盤・認証', '公開URLと利用者認証'],
  ['CONNECTIONS', '外部接続', 'LINE、メール、決済'],
  ['LEGAL_DATA', '法務・データ', '同意文書と個人情報の扱い'],
  ['OPERATIONS', '運用・復旧', '監視、停止、バックアップ']
];
const statusText: Record<CheckStatus, string> = { READY: '確認済み', BLOCKED: '要対応', MANUAL: '人による確認' };
const dateTime = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function AdminReadiness() {
  const [data, setData] = useState<AdminReadinessResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/v1/admin/readiness', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? '準備状況を取得できませんでした。');
      setData(result as AdminReadinessResponse);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const stateTitle = data?.status === 'NOT_READY' ? '本番公開には準備が必要です' : data?.status === 'MANUAL_REVIEW' ? '人による最終確認が必要です' : data ? '公開判断の確認へ進めます' : '準備状況を確認中';
  return <>
    <div className="page-heading"><span className="eyebrow">PRODUCTION READINESS</span><h1>本番準備チェック</h1><p>公開前に必要な設定と運用判断を、一画面で確認します。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <section className={`panel readiness-hero ${data?.status.toLowerCase() ?? ''}`} aria-label="本番準備の総合状態">
      <div className="readiness-state-icon">{data?.status === 'READY_FOR_REVIEW' ? <ShieldCheck /> : <AlertTriangle />}</div>
      <div><span className="eyebrow">CURRENT STATUS</span><h2>{stateTitle}</h2><p>{data ? `${dateTime(data.generatedAt)} JST 時点のサーバー判定です。` : 'サーバー設定と運用状態を読み込んでいます。'}</p></div>
      <button className="button secondary small" disabled={loading} onClick={() => void load()}><RefreshCw size={16} />再確認</button>
    </section>
    {data && <>
      <section className="readiness-counts" aria-label="本番準備チェック集計">
        <div className="ready"><span>確認済み</span><strong>{data.counts.ready}</strong><small>件</small></div>
        <div className="blocked"><span>要対応</span><strong>{data.counts.blocked}</strong><small>件</small></div>
        <div className="manual"><span>人による確認</span><strong>{data.counts.manual}</strong><small>件</small></div>
        <div><span>全項目</span><strong>{data.counts.total}</strong><small>件</small></div>
      </section>
      {groups.map(([group, title, description]) => <section className="panel readiness-section" key={group}><div className="panel-heading"><div><span className="eyebrow">{group}</span><h2>{title}</h2><small>{description}</small></div></div><div className="readiness-checks">
        {data.checks.filter(item => item.group === group).map(item => <article className={`readiness-check ${item.status.toLowerCase()}`} key={item.code}>
          <div className="readiness-check-icon">{item.status === 'READY' ? <CheckCircle2 /> : item.status === 'BLOCKED' ? <AlertTriangle /> : <CircleHelp />}</div>
          <div className="readiness-check-copy"><div><h3>{item.title}</h3><span className={`status-tag ${item.status.toLowerCase()}`}>{statusText[item.status]}</span></div><p>{item.evidence}</p><small><strong>次の対応：</strong>{item.action}</small></div>
          {item.href && <Link className="button secondary small" href={item.href}>確認する<ChevronRight size={16} /></Link>}
        </article>)}
      </div></section>)}
      <div className="notice readiness-declaration"><ShieldCheck size={18} /><strong>{data.declaration}</strong><span>公開責任者が外部サービスの疎通、法務文書、運用体制を確認して判断してください。</span></div>
    </>}
  </>;
}
