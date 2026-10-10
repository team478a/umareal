'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { emptyPredictionDraft, evaluationConfidences, finalMarks, publicationVisibilities, type ExpertPredictionDraftSaveResponse, type ExpertPredictionEditorResponse, type ExpertPredictionPreviewResponse, type ExpertPredictionPublishResponse, type PredictionDraft, type PublicFreeReportMetadataResponse, type PublicPredictionFullVersion, type PublicPredictionResponse } from '@keiba/domain';
import { RaceResultPanel } from './results';
import { PaidContentWatermark, type PaidContentViewer } from './paid-content-watermark';
import { RaceRelatedContent } from './content-library';
import { AiRaceGuidePanel } from './ai-race-guide';
import { encodePredictionEditorDraft, isPredictionEditorDraftCurrent, parsePredictionEditorDraft, predictionEditorDraftKey } from './prediction-drafts';

type State = ExpertPredictionEditorResponse;
type AssessmentSyncState = 'saved' | 'pending' | 'sending' | 'failed' | 'conflict';

const markLabels: Record<string, string> = { HONMEI: '◎ 最終本命', TAIKO: '○ 対抗', TANANA: '▲ 単穴', RENKA: '△ 連下', ANA: '☆ 穴候補', DANGER: '危険馬' };
const confidenceLabel = (value: string) => value === 'SKIP' ? '見送り' : `信頼度 ${value}`;
const quickSummary = 'パドックで直前に確認した注目馬です。';
const quickReason = 'パドック速報で選択';
const assessmentSyncMessages: Record<Exclude<AssessmentSyncState, 'saved'>, string> = {
  pending: '未送信のパドック評価があります。保存済みになってから最終評価・公開へ進んでください。',
  sending: 'パドック評価を送信中です。保存済みになるまでお待ちください。',
  failed: 'パドック評価を送信できていません。再同期して保存済みを確認してください。',
  conflict: 'パドック評価が競合しています。内容を比較して解決し、保存済みを確認してください。'
};

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/expert/races/${path}`, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理できませんでした。');
  return result;
}

export function PredictionEditor({ raceId, userId, assessmentSyncState }: { raceId: string; userId: string; assessmentSyncState: AssessmentSyncState }) {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<PredictionDraft>(emptyPredictionDraft);
  const [revision, setRevision] = useState(0);
  const [reason, setReason] = useState('最終評価の編集');
  const [correctionReason, setCorrectionReason] = useState('');
  const [preview, setPreview] = useState<ExpertPredictionPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [quickEntryIds, setQuickEntryIds] = useState<string[]>([]);
  const [quickConfidence, setQuickConfidence] = useState<Exclude<PredictionDraft['confidence'], 'SKIP'>>(null);
  const [quickVisibility, setQuickVisibility] = useState<'FREE' | 'PAID'>('FREE');
  const [quickCorrectionReason, setQuickCorrectionReason] = useState('');
  const previousAssessmentSyncState = useRef<AssessmentSyncState>(assessmentSyncState);
  const quickTouched = useRef(false);
  const storageKey = predictionEditorDraftKey(userId, raceId);

  async function load() {
    setError(''); setStorageReady(false); setRecoveryNotice('');
    try {
      const result = await request<State>(`${raceId}/prediction`);
      const predictionRevision = result.prediction?.revision ?? 0;
      let recovered = false; let loadedDraft = result.prediction?.draft ?? emptyPredictionDraft;
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        const stored = parsePredictionEditorDraft(raw);
        if (stored && isPredictionEditorDraftCurrent(stored, predictionRevision, result.race.revision)) {
          loadedDraft = stored.draft; setDraft(stored.draft); setReason(stored.reason); setCorrectionReason(stored.correctionReason); setDirty(true); recovered = true;
          setRecoveryNotice('この利用者・レースの未送信の最終評価を復元しました。内容を確認してサーバーへ保存してください。');
        } else if (raw) {
          window.sessionStorage.removeItem(storageKey);
          if (stored) setRecoveryNotice('サーバー側の内容が更新されたため、古い端末下書きを破棄しました。');
        }
      } catch { /* Storageが利用できなくてもサーバー下書きの編集は継続する。 */ }
      setState(result);
      if (!recovered) {
        setDraft(result.prediction?.draft ?? emptyPredictionDraft); setReason('最終評価の編集'); setCorrectionReason(''); setDirty(false);
      }
      if (!quickTouched.current) {
        setQuickEntryIds(loadedDraft.mode === 'QUICK_PICK' ? loadedDraft.marks.map(item => item.entryId) : []);
        setQuickConfidence(loadedDraft.confidence && loadedDraft.confidence !== 'SKIP' ? loadedDraft.confidence : null);
        setQuickVisibility(loadedDraft.visibility ?? 'FREE'); setQuickCorrectionReason('');
      }
      setRevision(predictionRevision); setStorageReady(true);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { quickTouched.current = false; void load(); }, [raceId]);
  useEffect(() => {
    const previous = previousAssessmentSyncState.current;
    previousAssessmentSyncState.current = assessmentSyncState;
    if (previous === 'saved' || assessmentSyncState !== 'saved') return;
    request<State>(`${raceId}/prediction`).then(result => setState(result)).catch(e => setError((e as Error).message));
  }, [assessmentSyncState, raceId]);
  useEffect(() => {
    if (!storageReady || !state || !dirty) return;
    try { window.sessionStorage.setItem(storageKey, encodePredictionEditorDraft({ predictionRevision: revision, raceRevision: state.race.revision, draft, reason, correctionReason })); }
    catch { /* Storage失敗でサーバー保存を妨げない。 */ }
  }, [correctionReason, dirty, draft, reason, revision, state, storageKey, storageReady]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = true; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function change(patch: Partial<PredictionDraft>) { setDraft(current => ({ ...current, mode: 'DETAILED', ...patch })); setDirty(true); setPreview(null); setMessage(''); }
  function mark(entryId: string, value: string) {
    const remaining = draft.marks.filter(item => item.entryId !== entryId);
    change({ marks: value ? [...remaining, { entryId, mark: value as typeof finalMarks[number], reason: draft.marks.find(item => item.entryId === entryId)?.reason ?? '' }] : remaining });
  }
  function markReason(entryId: string, value: string) { change({ marks: draft.marks.map(item => item.entryId === entryId ? { ...item, reason: value } : item) }); }
  async function saveDraft(nextDraft = draft, nextReason = reason) {
    if (!state) throw new Error('レース情報を再読み込みしてください。');
    const saved = await request<ExpertPredictionDraftSaveResponse>(`${raceId}/prediction/draft`, 'POST', { draft: nextDraft, revision, raceRevision: state.race.revision, mutationId: crypto.randomUUID(), reason: nextReason });
    setDraft(saved.draft); setReason(nextReason); setRevision(saved.revision); setDirty(false); setRecoveryNotice('');
    try { window.sessionStorage.removeItem(storageKey); } catch { /* 保存成功を優先する。 */ }
    setMessage('下書きを保存しました。'); return saved.revision;
  }
  function discardRecoveredDraft() {
    setDraft(state?.prediction?.draft ?? emptyPredictionDraft); setRevision(state?.prediction?.revision ?? 0);
    setReason('最終評価の編集'); setCorrectionReason(''); setDirty(false); setPreview(null); setRecoveryNotice(''); setError('');
    try { window.sessionStorage.removeItem(storageKey); } catch { /* 画面上の破棄は継続する。 */ }
    setMessage('端末の未送信下書きを破棄し、サーバーに保存済みの内容へ戻しました。');
  }
  async function save() { setBusy(true); setError(''); try { await saveDraft(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function check() {
    if (assessmentSyncState !== 'saved') { setError(assessmentSyncMessages[assessmentSyncState]); return; }
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try { const savedRevision = dirty || revision === 0 ? await saveDraft() : revision; setPreview(await request<ExpertPredictionPreviewResponse>(`${raceId}/prediction/preview`, 'POST', { predictionRevision: savedRevision, raceRevision: state!.race.revision, correctionReason })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function checkQuick() {
    if (!state || !quickEntryIds.length || !quickConfidence) { setError('注目馬と信頼度を選択してください。'); return; }
    if (assessmentSyncState !== 'saved') { setError(assessmentSyncMessages[assessmentSyncState]); return; }
    const selected = state.entries.filter(entry => entry.status === 'ACTIVE' && quickEntryIds.includes(entry.id));
    const nextDraft: PredictionDraft = { mode: 'QUICK_PICK', visibility: quickVisibility, confidence: quickConfidence, summary: quickSummary, marks: selected.map(entry => ({ entryId: entry.id, mark: 'TAIKO', reason: quickReason })) };
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try {
      const savedRevision = await saveDraft(nextDraft, quickReason);
      setPreview(await request<ExpertPredictionPreviewResponse>(`${raceId}/prediction/preview`, 'POST', { predictionRevision: savedRevision, raceRevision: state.race.revision, correctionReason: quickCorrectionReason }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publish() {
    if (assessmentSyncState !== 'saved') { setError(assessmentSyncMessages[assessmentSyncState]); return; }
    setBusy(true); setError('');
    try { const result = await request<ExpertPredictionPublishResponse>(`${raceId}/prediction/publish/${preview!.previewId}`, 'POST'); setPreview(null); await load(); setMessage(result.alreadyPublished ? 'この公開版は保存済みです。' : `公開版${result.version}を保存しました。`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!state) return <section className="panel panel-body"><h2>最終評価</h2><p role={error ? 'alert' : 'status'}>{error || '読み込み中…'}</p></section>;
  const correcting = state.versions.length > 0;
  const skip = draft.confidence === 'SKIP';
  const assessmentBlocked = assessmentSyncState !== 'saved';
  return <section className="prediction-editor">
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <section className="panel quick-paddock"><div className="panel-heading"><div><span className="eyebrow">QUICK PADDOCK</span><h2>かんたんパドック速報</h2></div><span className="status-tag">選択 → 確認 → 公開</span></div><div className="panel-body">
      <p>注目馬をタップすると「○」が付きます。複数馬を同列で選択できます。</p>
      <div className="quick-horse-grid" aria-label="パドック速報の注目馬選択">{state.entries.map(entry => { const selected = quickEntryIds.includes(entry.id); return <button type="button" key={entry.id} disabled={entry.status !== 'ACTIVE' || busy} className={selected ? 'selected' : ''} aria-pressed={selected} aria-label={`${entry.number}番 ${entry.horseName}${selected ? ' 選択済み' : ''}`} onClick={() => { quickTouched.current = true; setQuickEntryIds(current => current.includes(entry.id) ? current.filter(id => id !== entry.id) : [...current, entry.id]); setPreview(null); setMessage(''); }}><span className="quick-circle">{selected ? '○' : entry.number}</span><strong>{entry.number}番 {entry.horseName}</strong>{entry.status !== 'ACTIVE' && <small>{entry.status}</small>}</button>; })}</div>
      <div className="quick-settings"><label className="field">公開範囲<select aria-label="速報の公開範囲" value={quickVisibility} onChange={event => { quickTouched.current = true; setQuickVisibility(event.target.value as 'FREE' | 'PAID'); setPreview(null); }}><option value="FREE">無料会員へ公開</option><option value="PAID">有料会員へ公開</option></select></label><fieldset className="quick-confidence"><legend>信頼度</legend>{evaluationConfidences.filter(value => value !== 'SKIP').map(value => <button type="button" key={value} aria-pressed={quickConfidence === value} onClick={() => { quickTouched.current = true; setQuickConfidence(value); setPreview(null); }}>{value}</button>)}</fieldset></div>
      {correcting && <label className="field">訂正理由<input aria-label="速報の訂正理由" maxLength={500} value={quickCorrectionReason} onChange={event => { setQuickCorrectionReason(event.target.value); setPreview(null); }} /></label>}
      <button className="button" disabled={busy || assessmentBlocked || !quickEntryIds.length || !quickConfidence || (correcting && !quickCorrectionReason.trim())} onClick={() => void checkQuick()}>{busy ? '確認中…' : `選択した${quickEntryIds.length}頭の配信内容を確認`}</button>
      {preview?.draft.mode === 'QUICK_PICK' && <section className="quick-publish-preview"><h3>{preview.correction ? `訂正版 ${preview.version}` : `初版 ${preview.version}`}の配信前確認</h3><p>{preview.draft.visibility === 'FREE' ? '無料会員へ公開' : '有料会員へ公開'} ／ {confidenceLabel(preview.draft.confidence!)}</p><ul>{preview.draft.marks.map(mark => { const item = preview.entries.find(entry => entry.id === mark.entryId)!; return <li key={mark.entryId}><strong>○</strong> {item.number}番 {item.horseName}</li>; })}</ul>{preview.warnings.length > 0 && <div className="notice warning">{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}<button className="button publish-button" disabled={busy || assessmentBlocked} onClick={() => void publish()}>{busy ? '公開中…' : 'この内容で確定・公開'}</button><p className="muted form-note">公開後は変更・削除できません。訂正は新しい版として残ります。</p></section>}
    </div></section>
    <button className="button secondary" aria-label={open ? '評価入力に戻る' : '最終評価・公開へ'} disabled={!open && assessmentBlocked} onClick={() => setOpen(!open)}>{open ? '詳細評価を閉じる' : '詳細評価・見解を入力'}</button>{assessmentBlocked && <div className="notice warning" role="alert">{assessmentSyncMessages[assessmentSyncState]}</div>}{open && <div className="prediction-stack">
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">FINAL ASSESSMENT</span><h2>最終評価の下書き</h2></div><span className="status-tag">下書き版 {revision || '未保存'}</span></div><div className="panel-body">
      {recoveryNotice && <div className="notice warning" role="status">{recoveryNotice}</div>}
      {correcting && <div className="notice">公開済みです。次の公開は訂正版として新しい版を追加します。</div>}
      <div className="race-form-grid"><label className="field">公開範囲<select aria-label="公開範囲" value={draft.visibility ?? ''} onChange={e => change({ visibility: e.target.value as PredictionDraft['visibility'] })}><option value="">未選択</option>{publicationVisibilities.map(value => <option key={value} value={value}>{value === 'FREE' ? '無料会員向け（テスト設定中は全文）' : '有料会員'}</option>)}</select></label><label className="field">信頼度<select aria-label="信頼度" value={draft.confidence ?? ''} onChange={e => { const confidence = e.target.value as PredictionDraft['confidence']; change({ confidence, ...(confidence === 'SKIP' ? { marks: [] } : {}) }); }}><option value="">未選択</option>{evaluationConfidences.map(value => <option key={value} value={value}>{confidenceLabel(value)}</option>)}</select></label></div>
      <label className="field">最終見解<textarea aria-label="最終見解" rows={5} maxLength={5000} value={draft.summary} onChange={e => change({ summary: e.target.value })} /></label>
      <h3>最終評価</h3><div className="table-scroll"><table className="race-data-table"><thead><tr><th>馬</th><th>パドック診断</th><th>評価</th><th>選定理由</th></tr></thead><tbody>{state.entries.map(entry => { const selected = draft.marks.find(item => item.entryId === entry.id); return <tr key={entry.id}><td>{entry.number}番 {entry.horseName}{entry.status !== 'ACTIVE' && `（${entry.status}）`}</td><td>{entry.assessment?.content.change ?? '未入力'}<br /><small>{entry.assessment?.content.paddockComment}</small></td><td><select aria-label={`${entry.number}番の最終評価`} disabled={skip || entry.status !== 'ACTIVE'} value={selected?.mark ?? ''} onChange={e => mark(entry.id, e.target.value)}><option value="">評価なし</option>{finalMarks.map(value => <option value={value} key={value}>{markLabels[value]}</option>)}</select></td><td><input aria-label={`${entry.number}番の選定理由`} disabled={!selected} maxLength={1000} value={selected?.reason ?? ''} onChange={e => markReason(entry.id, e.target.value)} /></td></tr>; })}</tbody></table></div>
      <label className="field">下書きの変更理由<input aria-label="下書きの変更理由" maxLength={500} value={reason} onChange={e => { setReason(e.target.value); setDirty(true); setPreview(null); setMessage(''); }} /></label>
      {correcting && <label className="field">訂正理由<input aria-label="訂正理由" maxLength={500} value={correctionReason} onChange={e => { setCorrectionReason(e.target.value); setDirty(true); setPreview(null); setMessage(''); }} /></label>}
      {correcting && state.correctionPolicy === 'ADMIN_ONLY' && <p className="muted form-note">現在の開発設定では、訂正版の公開前確認と確定は管理者が行います。</p>}
      <div className="panel-actions"><button className="button secondary" disabled={busy || !reason.trim()} onClick={() => void save()}>{busy ? '処理中…' : '下書きを保存'}</button><button className="button" disabled={busy || assessmentBlocked || !reason.trim() || (correcting && !correctionReason.trim())} onClick={() => void check()}>公開前に確認</button>{dirty && <button className="button secondary" disabled={busy} onClick={discardRecoveredDraft}>端末の未送信下書きを破棄</button>}</div>
    </div></section>
    {preview && preview.draft.mode !== 'QUICK_PICK' && <section className="panel publish-preview"><div className="panel-heading"><div><span className="eyebrow">PUBLICATION REVIEW</span><h2>{preview.correction ? `訂正版 ${preview.version}` : `初版 ${preview.version}`}の公開前確認</h2></div></div><div className="panel-body"><p>公開範囲：{preview.draft.visibility === 'FREE' ? '無料会員向け（テスト設定中は全文）' : '有料会員'} ／ {confidenceLabel(preview.draft.confidence!)}</p><p>締切：{new Date(preview.deadlineAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>{preview.correction && <p>訂正理由：{preview.correctionReason}</p>}{preview.warnings.length > 0 && <div className="notice error" role="alert">{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}<h3>最終見解</h3><p>{preview.draft.summary}</p><h3>最終評価</h3>{preview.draft.confidence === 'SKIP' ? <p>見送り</p> : <ul>{preview.draft.marks.map(mark => { const entry = preview.entries.find(e => e.id === mark.entryId)!; return <li key={mark.entryId}>{markLabels[mark.mark]}：{entry.number}番 {entry.horseName} — {mark.reason}</li>; })}</ul>}<button className="button publish-button" disabled={busy || assessmentBlocked} onClick={() => void publish()}>{busy ? '公開中…' : preview.correction ? '訂正版を公開する' : '最終評価を公開する'}</button><p className="muted form-note">公開後はこの版を変更・削除できません。訂正は新しい版として残ります。</p></div></section>}
    {state.versions.length > 0 && <section className="panel"><div className="panel-heading"><h2>公開履歴</h2></div><div className="panel-body">{state.versions.map(version => <details key={version.id}><summary>版{version.version} · {version.status === 'CORRECTED' ? '訂正版' : '初版'} · {new Date(version.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</summary>{version.correctionReason && <p>訂正理由：{version.correctionReason}</p>}<p>{confidenceLabel(version.confidence)} · {version.summary}</p></details>)}</div></section>}
  </div>}</section>;
}

export function PublishedPrediction({ raceId, viewer }: { raceId: string; viewer: PaidContentViewer | null }) {
  const [result, setResult] = useState<PublicPredictionResponse | null>(null); const [freeReport, setFreeReport] = useState<PublicFreeReportMetadataResponse | null>(null); const [error, setError] = useState(''); const [selected, setSelected] = useState(0);
  useEffect(() => {
    fetch(`/api/v1/races/${raceId}/prediction`, { cache: 'no-store' }).then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.message); setResult(value as PublicPredictionResponse); }).catch(e => setError(e.message));
    fetch(`/api/v1/races/${raceId}/free-report`, { cache: 'no-store' }).then(async response => response.ok ? setFreeReport(await response.json() as PublicFreeReportMetadataResponse) : undefined).catch(() => undefined);
  }, [raceId]);
  if (error) return <div className="notice error" role="alert">{error}</div>;
  if (!result) return <p role="status">予想を読み込み中…</p>;
  const version = result.versions[selected];
  const published = version && !version.locked ? <VersionView version={version} /> : null;
  return <><div className="page-heading"><span className="eyebrow">PREDICTION</span><h1>{result.race.name}</h1><p>{result.race.venue} {result.race.number}R · {new Date(result.race.startsAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p></div>{freeReport?.versions.length ? <section className="panel panel-body"><span className="eyebrow">FREE REPORT</span><h2>無料パドック速報を公開済みです</h2>{freeReport.versions.map(item => <p className="muted" key={item.id}>第{item.version}版 · {item.kind === 'PRE_RACE' ? '発走前速報' : 'レース後検証'} · {new Date(item.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>)}<p>無料会員には公開状況のみをお知らせしています。馬の評価や詳細見解は有料会員向けの最終評価で確認できます。</p></section> : null}{!result.latest ? <section className="panel panel-body prediction-gate"><h2>最終評価は未公開です</h2><p>公開後にこちらで確認できます。LINE通知を設定すると、対象レース告知と公開のお知らせを受け取れます。</p><div className="gate-actions"><Link className="button" href="/account">LINE通知を確認</Link><Link className="button secondary" href="/plans">料金プランを見る</Link></div></section> : <><nav className="version-picker" aria-label="公開版選択">{result.versions.map((item, index) => <button className={`button ${selected === index ? '' : 'secondary'}`} key={item.id} onClick={() => setSelected(index)}>版{item.version}{item.status === 'CORRECTED' ? ' 訂正' : ''}</button>)}</nav>{version?.locked ? <section className="panel panel-body prediction-gate"><h2>有料会員向けの最終評価です</h2><p>版{version.version}は公開済みです。料金と申込内容を確認すると閲覧へ進めます。</p><div className="gate-actions"><Link className="button" href="/plans">料金プランを確認</Link><Link className="button secondary" href="/account">会員状態を確認</Link></div></section> : version?.visibility === 'PAID' && viewer ? <PaidContentWatermark viewer={viewer}>{published}</PaidContentWatermark> : published}</>}<AiRaceGuidePanel raceId={raceId} viewer={viewer} /><RaceResultPanel raceId={raceId} /><RaceRelatedContent raceId={raceId} /></>;
}

function VersionView({ version }: { version: PublicPredictionFullVersion }) {
  const assessments = Array.isArray(version.assessmentSnapshot) ? version.assessmentSnapshot : [];
  const quick = version.displayMode === 'QUICK_PICK';
  return <section className="panel published-prediction"><div className="panel-heading"><div><span className="eyebrow">MEMBERS ONLY</span><h2>{quick ? 'パドック速報' : '最終評価'} · 版{version.version}</h2></div><span className="status-tag">{version.status === 'CORRECTED' ? '訂正版' : '初版'}</span></div><div className="panel-body"><p className="muted">公開：{new Date(version.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>{version.correctionReason && <div className="notice">訂正理由：{version.correctionReason}</div>}<div className="prediction-summary"><span>{confidenceLabel(version.confidence)}</span></div><h3>{quick ? '速報コメント' : '最終見解'}</h3><p className="prediction-copy">{version.summary}</p><h3>{quick ? '○ パドック注目馬' : '最終評価'}</h3>{version.confidence === 'SKIP' ? <p>見送り</p> : <ul className="published-marks">{version.marks.map(mark => { const assessment = assessments.find(item => item.entryId === mark.entryId)?.assessment; return <li key={mark.id ?? mark.entryId}><strong>{quick ? '○ 注目馬' : markLabels[mark.mark]}</strong><span>{mark.horseNumber}番 {mark.horseName}</span>{!quick && <small>{mark.reason}</small>}{assessment?.change && <small>{assessment.change}：{assessment.paddockComment}</small>}</li>; })}</ul>}<p className="muted form-note">本予想は、馬の評価とレース見解を提供するものです。具体的な組み合わせや購入金額は指定していません。馬券を購入する場合は、ご自身の判断と責任で行ってください。</p></div></section>;
}
