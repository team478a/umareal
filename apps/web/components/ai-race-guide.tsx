'use client';
import { useEffect, useState } from 'react';
import type { AiRaceGuideAdminRaceListResponse, AiRaceGuideAdminResponse, AiRaceGuideDataCoverageResponse, AiRaceGuideGeneratedOutput, AiRaceGuidePublicResponse } from '@keiba/domain';
import { PaidContentWatermark, type PaidContentViewer } from './paid-content-watermark';

const sectionLabels: Record<string, string> = {
  RACE_OVERVIEW: 'レース概要', ATTENTION_MATERIALS: 'データ上の注目材料', ATTENTION_HORSES: '注目馬候補',
  POSITIVE_FACTORS: 'プラス材料', CAUTION_FACTORS: '注意材料', COURSE_SUITABILITY: 'コース適性',
  DISTANCE_SUITABILITY: '距離適性', GOING_SUITABILITY: '馬場適性', PEDIGREE_REFERENCES: '血統参考情報',
  RECENT_PERFORMANCE: '近走内容', PACE_REFERENCES: '展開参考情報', RACE_COMPLEXITY: 'レース難易度',
  PADDOCK_CHECK_POINTS: 'パドックで確認したいポイント'
};

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? '処理できませんでした。');
  return value as T;
}

function GuideContent({ content }: { content: AiRaceGuideGeneratedOutput }) {
  return <div className="ai-guide-sections">{content.sections.map(section => <section key={section.kind} className="ai-guide-section"><h3>{sectionLabels[section.kind] ?? section.kind}</h3><ul>{section.statements.map(statement => <li key={statement.statementId}>{statement.text}</li>)}</ul></section>)}</div>;
}

export function AiRaceGuidePanel({ raceId, viewer }: { raceId: string; viewer: PaidContentViewer | null }) {
  const [value, setValue] = useState<AiRaceGuidePublicResponse | null>(null);
  useEffect(() => {
    fetch(`/api/v1/races/${raceId}/ai-guide`, { cache: 'no-store' }).then(async response => response.ok ? setValue(await response.json() as AiRaceGuidePublicResponse) : undefined).catch(() => undefined);
  }, [raceId]);
  if (!value?.available) return null;
  const card = <section className="panel ai-race-guide" aria-labelledby="ai-race-guide-title"><div className="panel-heading"><div><span className="eyebrow">REFERENCE DATA</span><h2 id="ai-race-guide-title">AIレースガイド</h2></div><span className="status-tag">{value.accessScope === 'PAID_FULL' ? '全情報' : '無料プレビュー'}</span></div><div className="panel-body"><div className="notice"><strong>AIによる参考情報</strong><br />馬券の買い目を示すものではありません。</div><GuideContent content={value.content} /><dl className="ai-guide-meta"><div><dt>データ基準</dt><dd>{new Date(value.metadata.dataCutoffAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</dd></div><div><dt>生成</dt><dd>{new Date(value.metadata.generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</dd></div><div><dt>公開</dt><dd>{new Date(value.metadata.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</dd></div><div><dt>版</dt><dd>{value.metadata.version}</dd></div></dl>{value.accessScope === 'FREE_PREVIEW' && <p className="muted form-note">無料会員には概要を表示しています。有料会員と対象日の1日利用では全情報を確認できます。</p>}</div></section>;
  return value.accessScope === 'PAID_FULL' && viewer ? <PaidContentWatermark viewer={viewer}>{card}</PaidContentWatermark> : card;
}

export function AdminAiRaceGuide() {
  const [races, setRaces] = useState<AiRaceGuideAdminRaceListResponse['items']>([]);
  const [raceId, setRaceId] = useState('');
  const [state, setState] = useState<AiRaceGuideAdminResponse | null>(null);
  const [coverage, setCoverage] = useState<AiRaceGuideDataCoverageResponse | null>(null);
  const [reason, setReason] = useState('synthetic fixtureによる生成確認');
  const [correctionReason, setCorrectionReason] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { request<AiRaceGuideAdminRaceListResponse>('admin/ai-guide/races').then(value => { setRaces(value.items); setRaceId(value.items[0]?.id ?? ''); }).catch(error => setError(error.message)); }, []);
  useEffect(() => {
    if (!raceId) return;
    let active = true; setState(null); setCoverage(null); setError('');
    Promise.all([
      request<AiRaceGuideAdminResponse>(`admin/races/${raceId}/ai-guide`),
      request<AiRaceGuideDataCoverageResponse>(`admin/races/${raceId}/ai-guide/data-coverage`)
    ]).then(([guide, dataCoverage]) => { if (active) { setState(guide); setCoverage(dataCoverage); } }).catch(error => { if (active) { setState(null); setCoverage(null); setError(error.message); } });
    return () => { active = false; };
  }, [raceId]);
  async function mutate(action: 'generations' | 'corrections' | 'approve' | 'publish') {
    if (!state) return; setBusy(true); setError(''); setMessage('');
    try {
      const generationId = state.guide?.latestGenerationId;
      const body = { revision: state.guide?.revision ?? 0, mutationId: crypto.randomUUID(), reason, ...(action === 'approve' || action === 'publish' ? { generationId } : {}), ...(action === 'publish' ? { correctionReason } : {}) };
      const result = await request<AiRaceGuideAdminResponse>(`admin/races/${raceId}/ai-guide/${action}`, 'POST', body);
      setState(result); setMessage(action === 'generations' || action === 'corrections' ? '生成・検証が完了しました。' : action === 'approve' ? '確認済みにしました。' : '新しい公開版を保存しました。');
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  const generation = state?.generations[0];
  return <><div className="page-heading"><span className="eyebrow">ADMIN · SYNTHETIC ONLY</span><h1>AIレースガイド管理</h1><p>外部AIへ接続せず、synthetic fixtureで生成・検証・公開フローを確認します。</p></div>{error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}<section className="panel panel-body"><label className="field">対象レース<select value={raceId} onChange={event => setRaceId(event.target.value)}><option value="">選択してください</option>{races.map(race => <option key={race.id} value={race.id}>{race.raceDate} {race.venue} {race.number}R {race.name}</option>)}</select></label>{coverage && <div className="ai-guide-coverage" aria-label="AI補助データcoverage"><h2>データcoverage</h2><p className="muted">基準時刻 {new Date(coverage.dataCutoffAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST · {coverage.logicVersion}</p><div className="ai-guide-coverage-grid">{coverage.coverage.map(item => <article key={item.category}><strong>{item.category}</strong><span className="status-tag">{item.status}</span><p>{item.availableCount}/{item.requiredCount}</p><small>{item.note}</small></article>)}</div><p className="muted form-note">Assessment・Prediction・三国谷コメント・会員情報は事前Factへ使用しません。cutoff後の結果も除外します。</p></div>}{state && <><div className="ai-guide-admin-status"><span className="status-tag">{state.guide?.status ?? '未生成'}</span><span>revision {state.guide?.revision ?? 0}</span><span>transport {state.runtime.transport}</span></div><label className="field">操作理由<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label><label className="field">訂正理由（2版目以降）<input value={correctionReason} maxLength={500} onChange={event => setCorrectionReason(event.target.value)} /></label><div className="panel-actions"><button className="button secondary" disabled={busy || !state.runtime.generationEnabled || !reason.trim()} onClick={() => void mutate(state.versions.length ? 'corrections' : 'generations')}>{busy ? '処理中…' : state.versions.length ? '訂正用に再生成' : 'synthetic fixtureで生成'}</button><button className="button secondary" disabled={busy || state.guide?.status !== 'REVIEW_REQUIRED'} onClick={() => void mutate('approve')}>確認済みにする</button><button className="button" disabled={busy || !state.runtime.publicationEnabled || state.guide?.status !== 'READY' || (state.versions.length > 0 && !correctionReason.trim())} onClick={() => void mutate('publish')}>公開版を追加</button></div></>}</section>{generation && <><section className="panel"><div className="panel-heading"><div><span className="eyebrow">GENERATION {generation.attemptNo}</span><h2>生成・検証結果</h2></div><span className="status-tag">{generation.validationStatus}</span></div><div className="panel-body"><dl className="ai-guide-meta"><div><dt>data cutoff</dt><dd>{generation.dataCutoffAt}</dd></div><div><dt>input hash</dt><dd className="mono">{generation.inputHash}</dd></div><div><dt>logic</dt><dd>{generation.logicVersion}</dd></div><div><dt>prompt</dt><dd>{generation.promptVersion}</dd></div><div><dt>provider / model</dt><dd>{generation.modelProvider} / {generation.modelVersion}</dd></div></dl>{generation.validationErrors.length > 0 && <div className="notice error">{generation.validationErrors.map(item => <p key={item}>{item}</p>)}</div>}<details><summary>Fact / Evidenceを確認</summary><pre className="ai-guide-json">{JSON.stringify({ facts: generation.structuredInputSnapshot.facts, evidence: generation.structuredInputSnapshot.evidence }, null, 2)}</pre></details></div></section>{generation.generatedOutput && <section className="panel"><div className="panel-heading"><h2>AI生成文・会員表示プレビュー</h2></div><div className="panel-body"><div className="notice"><strong>AIによる参考情報</strong><br />馬券の買い目を示すものではありません。</div><GuideContent content={generation.generatedOutput} /></div></section>}</>}</>;
}
