'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, RefreshCw, Users } from 'lucide-react';

type FunnelStage = {
  key: string;
  label: string;
  value: number;
  rateFromRegistered: number;
  dropOffFromPrevious: number;
  rateFromPrevious: number;
};

type FunnelResponse = {
  days: number;
  since: string;
  source: string | null;
  sources: string[];
  stages: FunnelStage[];
  paid: number;
  lineAvailable: boolean;
  trackingStartsAt: string | null;
  generatedAt: string;
};

async function request(days: number, source: string) {
  const query = new URLSearchParams({ days: String(days) });
  if (source) query.set('source', source);
  const response = await fetch(`/api/v1/admin/onboarding-funnel?${query}`, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? '登録ファネルを取得できませんでした。');
  return body as FunnelResponse;
}

const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
}).format(new Date(value));

export function OnboardingFunnel() {
  const [days, setDays] = useState(30);
  const [source, setSource] = useState('');
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await request(days, source)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  }, [days, source]);
  useEffect(() => { void load(); }, [load]);

  return <>
    <div className="page-heading"><span className="eyebrow">FREE MEMBER ONBOARDING</span><h1>無料会員 登録ファネル</h1><p>登録後の本人確認、初回ログイン、LINE案内への到達状況を確認します。</p></div>
    <section className="panel funnel-controls" aria-label="集計条件">
      <label>集計期間<select value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>直近7日</option><option value={30}>直近30日</option><option value={90}>直近90日</option><option value={365}>直近365日</option></select></label>
      <label>流入元<select value={source} onChange={event => setSource(event.target.value)}><option value="">すべて</option>{data?.sources.map(item => <option value={item} key={item}>{item}</option>)}</select></label>
      <button className="button secondary small" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} />更新</button>
    </section>
    {error && <div className="notice error" role="alert">{error}</div>}
    {loading && !data ? <p role="status">登録状況を集計中…</p> : data && <>
      {!data.lineAvailable && <div className="notice">現在は無料会員募集モードのため、LINE案内とLINE受信準備は有効化後に計測されます。</div>}
      <section className="panel onboarding-funnel-panel" aria-labelledby="onboarding-funnel-title">
        <div className="panel-heading"><div><span className="eyebrow">COHORT</span><h2 id="onboarding-funnel-title">{data.days}日以内に登録した会員</h2></div><span className="count-tag">{data.source ?? '全流入元'}</span></div>
        <div className="onboarding-funnel-list">{data.stages.map((stage, index) => <article className="onboarding-funnel-stage" key={stage.key}>
          <span className="onboarding-funnel-index">{index + 1}</span>
          <div><strong>{stage.label}</strong><small>{index === 0 ? '集計対象の無料会員' : `前段階から ${stage.rateFromPrevious}%`}</small></div>
          <div className="onboarding-funnel-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, stage.rateFromRegistered)}%` }} /></div>
          <b>{stage.value}<small>人 · 登録比 {stage.rateFromRegistered}%</small></b>
          {index > 0 && <span className={`onboarding-dropoff ${stage.dropOffFromPrevious ? 'has-dropoff' : ''}`}>{stage.dropOffFromPrevious}人が未到達</span>}
        </article>)}</div>
        <div className="panel-foot onboarding-funnel-foot"><span><Users size={16} />有料化済み {data.paid}人</span><span>集計開始 {formatDate(data.since)} JST</span></div>
      </section>
      <section className="panel funnel-guidance"><div className="panel-heading"><h2>数値の見方</h2></div><div className="panel-body"><p>各人数は、期間内に登録した同じ会員群がその段階へ一度でも到達したかを集計しています。本人確認はメール確認済みまたはLINE登録、初回ログイン以降は導入後にサーバーが記録した初回到達です。</p>{data.trackingStartsAt ? <p className="muted">初回ログイン・LINE案内の計測開始：{formatDate(data.trackingStartsAt)} JST</p> : <p className="muted">初回ログイン・LINE案内の計測データはまだありません。</p>}<a className="text-link" href="/admin/acquisition">キャンペーン・流入管理を見る <ArrowRight size={16} /></a></div></section>
    </>}
  </>;
}
