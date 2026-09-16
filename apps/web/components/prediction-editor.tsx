'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { emptyPredictionDraft, evaluationConfidences, finalMarks, publicationVisibilities, type PredictionDraft } from '@keiba/domain';
import { RaceResultPanel } from './results';

type Entry = { id: string; number: number; horseName: string; status: string; assessment?: { content: { change?: string | null; paddockComment?: string } } | null };
type Assessment = { entryId: string; number: number; horseName: string; assessment: { change?: string | null; paddockComment?: string } | null };
type Version = { id: string; version: number; status: string; visibility: string; confidence: string; formatVersion: string; summary: string; assessmentSnapshot: Assessment[]; publishedAt: string; correctionReason: string | null; marks: { id?: string; entryId: string; horseNumber: number; horseName: string; mark: string; reason: string }[] };
type PublicVersion = { id: string; version: number; status: string; visibility: string; publishedAt: string; previousVersionId?: string | null; locked: boolean } & Partial<Version>;
type State = { race: { id: string; name: string; venue: string; number: number; startsAt: string; status: string; revision: number }; entries: Entry[]; prediction: { id: string; revision: number; draft: PredictionDraft } | null; versions: Version[]; correctionPolicy: string };
type Preview = { previewId: string; expiresAt: string; version: number; correction: boolean; correctionReason: string; warnings: string[]; deadlineAt: string; draft: PredictionDraft; entries: Entry[] };

const markLabels: Record<string, string> = { HONMEI: '◎ 最終本命', TAIKO: '○ 対抗', TANANA: '▲ 単穴', RENKA: '△ 連下', ANA: '☆ 穴候補', DANGER: '危険馬' };
const confidenceLabel = (value: string) => value === 'SKIP' ? '見送り' : `信頼度 ${value}`;

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/expert/races/${path}`, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理できませんでした。');
  return result;
}

export function PredictionEditor({ raceId }: { raceId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<PredictionDraft>(emptyPredictionDraft);
  const [revision, setRevision] = useState(0);
  const [reason, setReason] = useState('最終評価の編集');
  const [correctionReason, setCorrectionReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);

  async function load() {
    setError('');
    try {
      const result = await request<State>(`${raceId}/prediction`);
      setState(result);
      setDraft(result.prediction?.draft ?? emptyPredictionDraft);
      setRevision(result.prediction?.revision ?? 0);
      setDirty(false);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [raceId]);

  function change(patch: Partial<PredictionDraft>) { setDraft(current => ({ ...current, ...patch })); setDirty(true); setPreview(null); setMessage(''); }
  function mark(entryId: string, value: string) {
    const remaining = draft.marks.filter(item => item.entryId !== entryId);
    change({ marks: value ? [...remaining, { entryId, mark: value as typeof finalMarks[number], reason: draft.marks.find(item => item.entryId === entryId)?.reason ?? '' }] : remaining });
  }
  function markReason(entryId: string, value: string) { change({ marks: draft.marks.map(item => item.entryId === entryId ? { ...item, reason: value } : item) }); }
  async function saveDraft() {
    if (!state) throw new Error('レース情報を再読み込みしてください。');
    const saved = await request<{ revision: number; draft: PredictionDraft }>(`${raceId}/prediction/draft`, 'POST', { draft, revision, raceRevision: state.race.revision, mutationId: crypto.randomUUID(), reason });
    setDraft(saved.draft); setRevision(saved.revision); setDirty(false); setMessage('下書きを保存しました。'); return saved.revision;
  }
  async function save() { setBusy(true); setError(''); try { await saveDraft(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function check() {
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try { const savedRevision = dirty || revision === 0 ? await saveDraft() : revision; setPreview(await request<Preview>(`${raceId}/prediction/preview`, 'POST', { predictionRevision: savedRevision, raceRevision: state!.race.revision, correctionReason })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setError('');
    try { const result = await request<{ version: number }>(`${raceId}/prediction/publish/${preview!.previewId}`, 'POST'); setPreview(null); await load(); setMessage(`公開版${result.version}を保存しました。`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!state) return <section className="panel panel-body"><h2>最終評価</h2><p role={error ? 'alert' : 'status'}>{error || '読み込み中…'}</p></section>;
  const correcting = state.versions.length > 0;
  const skip = draft.confidence === 'SKIP';
  return <section className="prediction-editor"><button className="button" onClick={() => setOpen(!open)}>{open ? '評価入力に戻る' : '最終評価・公開へ'}</button>{open && <div className="prediction-stack">
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">FINAL ASSESSMENT</span><h2>最終評価の下書き</h2></div><span className="status-tag">下書き版 {revision || '未保存'}</span></div><div className="panel-body">
      {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
      {correcting && <div className="notice">公開済みです。次の公開は訂正版として新しい版を追加します。</div>}
      <div className="race-form-grid"><label className="field">公開範囲<select aria-label="公開範囲" value={draft.visibility ?? ''} onChange={e => change({ visibility: e.target.value as PredictionDraft['visibility'] })}><option value="">未選択</option>{publicationVisibilities.map(value => <option key={value} value={value}>{value === 'FREE' ? '無料会員（概要のみ）' : '有料会員'}</option>)}</select></label><label className="field">信頼度<select aria-label="信頼度" value={draft.confidence ?? ''} onChange={e => { const confidence = e.target.value as PredictionDraft['confidence']; change({ confidence, ...(confidence === 'SKIP' ? { marks: [] } : {}) }); }}><option value="">未選択</option>{evaluationConfidences.map(value => <option key={value} value={value}>{confidenceLabel(value)}</option>)}</select></label></div>
      <label className="field">最終見解<textarea aria-label="最終見解" rows={5} maxLength={5000} value={draft.summary} onChange={e => change({ summary: e.target.value })} /></label>
      <h3>最終評価</h3><div className="table-scroll"><table className="race-data-table"><thead><tr><th>馬</th><th>パドック診断</th><th>評価</th><th>選定理由</th></tr></thead><tbody>{state.entries.map(entry => { const selected = draft.marks.find(item => item.entryId === entry.id); return <tr key={entry.id}><td>{entry.number}番 {entry.horseName}{entry.status !== 'ACTIVE' && `（${entry.status}）`}</td><td>{entry.assessment?.content.change ?? '未入力'}<br /><small>{entry.assessment?.content.paddockComment}</small></td><td><select aria-label={`${entry.number}番の最終評価`} disabled={skip || entry.status !== 'ACTIVE'} value={selected?.mark ?? ''} onChange={e => mark(entry.id, e.target.value)}><option value="">評価なし</option>{finalMarks.map(value => <option value={value} key={value}>{markLabels[value]}</option>)}</select></td><td><input aria-label={`${entry.number}番の選定理由`} disabled={!selected} maxLength={1000} value={selected?.reason ?? ''} onChange={e => markReason(entry.id, e.target.value)} /></td></tr>; })}</tbody></table></div>
      <label className="field">下書きの変更理由<input aria-label="下書きの変更理由" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {correcting && <label className="field">訂正理由<input aria-label="訂正理由" maxLength={500} value={correctionReason} onChange={e => { setCorrectionReason(e.target.value); setPreview(null); }} /></label>}
      {correcting && state.correctionPolicy === 'ADMIN_ONLY' && <p className="muted form-note">現在の開発設定では、訂正版の公開前確認と確定は管理者が行います。</p>}
      <div className="panel-actions"><button className="button secondary" disabled={busy || !reason.trim()} onClick={() => void save()}>{busy ? '処理中…' : '下書きを保存'}</button><button className="button" disabled={busy || !reason.trim() || (correcting && !correctionReason.trim())} onClick={() => void check()}>公開前に確認</button></div>
    </div></section>
    {preview && <section className="panel publish-preview"><div className="panel-heading"><div><span className="eyebrow">PUBLICATION REVIEW</span><h2>{preview.correction ? `訂正版 ${preview.version}` : `初版 ${preview.version}`}の公開前確認</h2></div></div><div className="panel-body"><p>公開範囲：{preview.draft.visibility === 'FREE' ? '無料会員（概要のみ）' : '有料会員'} ／ {confidenceLabel(preview.draft.confidence!)}</p><p>締切：{new Date(preview.deadlineAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>{preview.correction && <p>訂正理由：{preview.correctionReason}</p>}{preview.warnings.length > 0 && <div className="notice error" role="alert">{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}<h3>最終見解</h3><p>{preview.draft.summary}</p><h3>最終評価</h3>{preview.draft.confidence === 'SKIP' ? <p>見送り</p> : <ul>{preview.draft.marks.map(mark => { const entry = preview.entries.find(e => e.id === mark.entryId)!; return <li key={mark.entryId}>{markLabels[mark.mark]}：{entry.number}番 {entry.horseName} — {mark.reason}</li>; })}</ul>}<button className="button publish-button" disabled={busy} onClick={() => void publish()}>{busy ? '公開中…' : preview.correction ? '訂正版を公開する' : '最終評価を公開する'}</button><p className="muted form-note">公開後はこの版を変更・削除できません。訂正は新しい版として残ります。</p></div></section>}
    {state.versions.length > 0 && <section className="panel"><div className="panel-heading"><h2>公開履歴</h2></div><div className="panel-body">{state.versions.map(version => <details key={version.id}><summary>版{version.version} · {version.status === 'CORRECTED' ? '訂正版' : '初版'} · {new Date(version.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</summary>{version.correctionReason && <p>訂正理由：{version.correctionReason}</p>}<p>{confidenceLabel(version.confidence)} · {version.summary}</p></details>)}</div></section>}
  </div>}</section>;
}

type PublicResult = { race: { id: string; name: string; venue: string; number: number; startsAt: string }; latest: PublicVersion | null; versions: PublicVersion[]; total: number; locked: boolean };
type FreeReportMetadata = { versions: { id: string; version: number; kind: 'PRE_RACE' | 'POST_RACE_REVIEW'; publishedAt: string }[] };
export function PublishedPrediction({ raceId }: { raceId: string }) {
  const [result, setResult] = useState<PublicResult | null>(null); const [freeReport, setFreeReport] = useState<FreeReportMetadata | null>(null); const [error, setError] = useState(''); const [selected, setSelected] = useState(0);
  useEffect(() => {
    fetch(`/api/v1/races/${raceId}/prediction`, { cache: 'no-store' }).then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.message); setResult(value); }).catch(e => setError(e.message));
    fetch(`/api/v1/races/${raceId}/free-report`, { cache: 'no-store' }).then(async response => response.ok ? setFreeReport(await response.json()) : undefined).catch(() => undefined);
  }, [raceId]);
  if (error) return <div className="notice error" role="alert">{error}</div>;
  if (!result) return <p role="status">予想を読み込み中…</p>;
  const version = result.versions[selected];
  return <><div className="page-heading"><span className="eyebrow">PREDICTION</span><h1>{result.race.name}</h1><p>{result.race.venue} {result.race.number}R · {new Date(result.race.startsAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p></div>{freeReport?.versions.length ? <section className="panel panel-body"><span className="eyebrow">FREE REPORT</span><h2>無料パドック速報を公開済みです</h2>{freeReport.versions.map(item => <p className="muted" key={item.id}>第{item.version}版 · {item.kind === 'PRE_RACE' ? '発走前速報' : 'レース後検証'} · {new Date(item.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>)}<p>無料会員には公開状況のみをお知らせしています。馬の評価や詳細見解は有料会員向けの最終評価で確認できます。</p></section> : null}{!result.latest ? <section className="panel panel-body prediction-gate"><h2>最終評価は未公開です</h2><p>公開後にこちらで確認できます。LINE通知を設定すると、対象レース告知と公開のお知らせを受け取れます。</p><div className="gate-actions"><Link className="button" href="/account">LINE通知を確認</Link><Link className="button secondary" href="/plans">料金プランを見る</Link></div></section> : <><nav className="version-picker" aria-label="公開版選択">{result.versions.map((item, index) => <button className={`button ${selected === index ? '' : 'secondary'}`} key={item.id} onClick={() => setSelected(index)}>版{item.version}{item.status === 'CORRECTED' ? ' 訂正' : ''}</button>)}</nav>{version?.locked ? <section className="panel panel-body prediction-gate"><h2>有料会員向けの最終評価です</h2><p>版{version.version}は公開済みです。料金と申込内容を確認すると閲覧へ進めます。</p><div className="gate-actions"><Link className="button" href="/plans">料金プランを確認</Link><Link className="button secondary" href="/account">会員状態を確認</Link></div></section> : version ? <VersionView version={version as Version} /> : null}</>}<RaceResultPanel raceId={raceId} /></>;
}

function VersionView({ version }: { version: Version }) {
  const assessments = Array.isArray(version.assessmentSnapshot) ? version.assessmentSnapshot : [];
  return <section className="panel published-prediction"><div className="panel-heading"><div><span className="eyebrow">MEMBERS ONLY</span><h2>最終評価 · 版{version.version}</h2></div><span className="status-tag">{version.status === 'CORRECTED' ? '訂正版' : '初版'}</span></div><div className="panel-body"><p className="muted">公開：{new Date(version.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>{version.correctionReason && <div className="notice">訂正理由：{version.correctionReason}</div>}<div className="prediction-summary"><span>{confidenceLabel(version.confidence)}</span></div><h3>最終見解</h3><p className="prediction-copy">{version.summary}</p><h3>最終評価</h3>{version.confidence === 'SKIP' ? <p>見送り</p> : <ul className="published-marks">{version.marks.map(mark => { const assessment = assessments.find(item => item.entryId === mark.entryId)?.assessment; return <li key={mark.id ?? mark.entryId}><strong>{markLabels[mark.mark]}</strong><span>{mark.horseNumber}番 {mark.horseName}</span><small>{mark.reason}</small>{assessment?.change && <small>{assessment.change}：{assessment.paddockComment}</small>}</li>; })}</ul>}<p className="muted form-note">本予想は、馬の評価とレース見解を提供するものです。具体的な組み合わせや購入金額は指定していません。馬券を購入する場合は、ご自身の判断と責任で行ってください。</p></div></section>;
}
