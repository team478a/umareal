'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { assessmentSaveSchema, blankAssessment, changeLabels, changes, markLabels, marks, metricLabels, metrics, paddockComplete, preComplete, type AssessmentInput } from '@keiba/domain';
import { PredictionEditor } from './prediction-editor';
type Saved = { revision: number; content: AssessmentInput };
type Entry = { id: string; horseId: string; number: number; horseName: string; status: string; assessment: Saved | null };
type Workspace = { race: { id: string; name: string; venue: string; number: number; startsAt: string; status: string; revision: number }; entries: Entry[] };
type Draft = { content: AssessmentInput; revision: number; raceRevision: number; horseId: string; mutationId: string; reason: string };
type Drafts = Record<string, Draft>;
const fieldLabels: Record<string, string> = { preScore: '事前点数', preRank: '事前順位', preMark: '事前印', preComment: '事前短評', ...metricLabels, change: '総合変化', paddockComment: 'パドック短評' };
function valueText(key: string, value: unknown) {
  if (value === null || value === undefined) return '未入力';
  if (key in metricLabels) return value === 0 ? '判断不能' : String(value);
  if (key === 'preMark') return markLabels[value as keyof typeof markLabels];
  if (key === 'change') return changeLabels[value as keyof typeof changeLabels];
  return String(value);
}
class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/expert/races/${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.message ?? '通信を確認してください。', response.status);
  return result;
}
export function AssessmentEditor({ raceId, userId, onClose }: { raceId: string; userId: string; onClose: () => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null); const [drafts, setDrafts] = useState<Drafts>({});
  const [index, setIndex] = useState(0); const [mode, setMode] = useState<'pre' | 'paddock'>('paddock'); const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null); const [reason, setReason] = useState('担当評価の入力');
  const [review, setReview] = useState(false); const [history, setHistory] = useState<{ revision: number; content: AssessmentInput; reason: string; createdAt: string }[]>([]);
  const [onlineVersion, setOnlineVersion] = useState(0);
  const [historyPage, setHistoryPage] = useState(1); const [historyTotal, setHistoryTotal] = useState(0);
  const storageKey = `keiba:assessment:${userId}:${raceId}`; const raw = useRef<string | null>(null); const sending = useRef(false);
  const persist = useCallback((next: Drafts) => {
    if (localStorage.getItem(storageKey) !== raw.current) throw new Error('別のタブで一時保存が変更されました。このタブの内容を確認してから再読み込みしてください。');
    const encoded = JSON.stringify(next); localStorage.setItem(storageKey, encoded); raw.current = encoded; setDrafts(next);
  }, [storageKey]);
  const load = useCallback(async () => {
    try {
      const result = await request<Workspace>(`${raceId}/assessments`);
      raw.current = localStorage.getItem(storageKey);
      const stored: unknown = JSON.parse(raw.current ?? '{}');
      const restored: Drafts = {};
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) for (const [entryId, draft] of Object.entries(stored)) {
        const parsed = assessmentSaveSchema.safeParse(draft); if (parsed.success) restored[entryId] = parsed.data;
      }
      setWorkspace(result); setDrafts(restored); setReady(true); setError('');
    } catch (e) { setError((e as Error).message); }
  }, [raceId, storageKey]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const online = () => { setFailed(false); setError(''); setOnlineVersion(v => v + 1); };
    window.addEventListener('online', online); return () => window.removeEventListener('online', online);
  }, []);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (Object.keys(drafts).length) event.preventDefault(); };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [drafts]);
  useEffect(() => {
    if (!ready || failed || conflict || busy || !Object.keys(drafts).length) return;
    const timer = setTimeout(async () => {
      if (sending.current || !navigator.onLine) return;
      const [entryId, draft] = Object.entries(drafts)[0]; sending.current = true; setBusy(true);
      try {
        if (localStorage.getItem(storageKey) !== raw.current) throw new Error('別のタブが一時保存を変更しました。再読み込みして確認してください。');
        const saved = await request<Saved>(`${raceId}/entries/${entryId}/assessment`, draft);
        const next = { ...drafts }; delete next[entryId]; persist(next);
        setWorkspace(current => current ? { ...current, entries: current.entries.map(e => e.id === entryId ? { ...e, assessment: saved } : e) } : current);
        setError('');
      } catch (e) {
        setError((e as Error).message); setFailed(true);
        if (e instanceof RequestError && e.status === 409) {
          setConflict(entryId);
          try { setWorkspace(await request<Workspace>(`${raceId}/assessments`)); } catch { /* Keep local draft; retry reload explicitly. */ }
        }
      } finally { sending.current = false; setBusy(false); }
    }, Object.keys(drafts).length > 1 ? 0 : 650);
    return () => clearTimeout(timer);
  }, [ready, failed, conflict, busy, drafts, persist, raceId, storageKey, onlineVersion]);
  if (!workspace || !ready) return <section className="panel panel-body"><h2>評価入力</h2><p role={error ? 'alert' : 'status'}>{error || '読み込み中…'}</p><button className="button secondary" onClick={() => void load()}>再読み込み</button><button className="text-link" onClick={onClose}>担当一覧に戻る</button></section>;
  const entry = workspace.entries[index];
  const contentFor = (e: Entry) => drafts[e.id]?.content ?? e.assessment?.content ?? blankAssessment;
  const content = entry ? contentFor(entry) : blankAssessment;
  function edit(patch: Partial<AssessmentInput>) {
    if (!entry || busy || failed || conflict) return;
    const previous = drafts[entry.id];
    const next = { ...drafts, [entry.id]: { content: { ...content, ...patch }, revision: previous?.revision ?? entry.assessment?.revision ?? 0, raceRevision: previous?.raceRevision ?? workspace!.race.revision, horseId: entry.horseId, mutationId: crypto.randomUUID(), reason: reason.trim() } };
    if (!assessmentSaveSchema.safeParse(next[entry.id]).success) { setError('入力範囲を確認してください。点数0〜100、順位1〜18、短評1000文字以内です。'); return; }
    try { persist(next); setError(''); } catch (e) { setDrafts(next); setFailed(true); setError(`端末に保存できません：${(e as Error).message} 入力を控えてから再読み込みしてください。`); }
  }
  async function resolve(keepLocal: boolean) {
    if (!conflict) return;
    try {
      const latest = await request<Workspace>(`${raceId}/assessments`); const current = latest.entries.find(e => e.id === conflict);
      if (latest.race.revision !== workspace!.race.revision || current?.assessment?.revision !== workspace!.entries.find(e => e.id === conflict)?.assessment?.revision) {
        setWorkspace(latest); throw new Error('比較中に再更新されました。表示された最新の内容をもう一度確認してください。');
      }
      const next = { ...drafts };
      if (keepLocal) {
        if (!current || current.horseId !== drafts[conflict].horseId) throw new Error('対象馬が変更されたため、この入力は再送できません。内容を控えてから最新情報を採用してください。');
        next[conflict] = { ...drafts[conflict], revision: current.assessment?.revision ?? 0, raceRevision: latest.race.revision, mutationId: crypto.randomUUID(), reason: reason.trim() };
      } else delete next[conflict];
      persist(next); setWorkspace(latest); setConflict(null); setFailed(false); setError('');
    } catch (e) { setError((e as Error).message); }
  }
  async function loadHistory(page = 1) {
    try { const result = await request<{ items: typeof history; total: number }>(`${raceId}/entries/${entry.id}/history?page=${page}`); setHistory(result.items); setHistoryPage(page); setHistoryTotal(result.total); }
    catch (e) { setError((e as Error).message); }
  }
  const completed = workspace.entries.filter(e => paddockComplete(contentFor(e))).length;
  const incomplete = workspace.entries.filter(e => !paddockComplete(contentFor(e)));
  const pending = Object.keys(drafts).length;
  return <div className="assessment-workspace">
    <button className="text-link" onClick={onClose}>← 担当レースに戻る</button>
    <div className="page-heading"><span className="eyebrow">EXPERT INPUT</span><h1>{workspace.race.name}</h1><p>{workspace.race.venue} {workspace.race.number}R · {new Date(workspace.race.startsAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p></div>
    <div className="assessment-progress"><strong>パドック入力 {completed} / {workspace.entries.length}頭</strong><span role="status">{conflict ? '競合' : busy ? '送信中' : pending ? `未送信 ${pending}頭` : '保存済み'}</span><p>未入力：{incomplete.map(e => `${e.number}番`).join('、') || 'なし'}</p>
      {entry && <strong>{entry.number}番 {entry.horseName} · 事前順位 {content.preRank ?? '未入力'} · {content.preMark ? markLabels[content.preMark] : '事前印 未入力'}</strong>}
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {failed && !conflict && <button className="button secondary" onClick={() => { setFailed(false); setError(''); }}>再同期する</button>}
    {conflict && <section className="panel panel-body"><h2>競合する入力の確認</h2><p>端末の入力は保持しています。最新情報と比較して選択してください。</p><div className="table-scroll"><table className="race-data-table"><thead><tr><th>項目</th><th>この端末</th><th>サーバーの最新</th></tr></thead><tbody>{Object.entries(drafts[conflict].content).map(([key, value]) => <tr key={key}><td>{fieldLabels[key]}</td><td>{valueText(key, value)}</td><td>{valueText(key, workspace.entries.find(e => e.id === conflict)?.assessment?.content[key as keyof AssessmentInput])}</td></tr>)}</tbody></table></div><button className="button secondary" onClick={() => void resolve(false)}>サーバーの内容を採用</button><button className="button" disabled={!reason.trim()} onClick={() => void resolve(true)}>比較した端末の入力を再送</button></section>}
    {!entry ? <p>出走馬が未登録です。管理画面で登録してください。</p> : <>
      <nav className="horse-picker" aria-label="出走馬選択">{workspace.entries.map((e, i) => <button key={e.id} className={`button ${index === i ? '' : 'secondary'}`} aria-pressed={index === i} onClick={() => { setIndex(i); setHistory([]); }}>{e.number}番 {paddockComplete(contentFor(e)) ? '✓' : '未'}</button>)}</nav>
      <div className="assessment-tabs"><button className="button secondary" aria-pressed={mode === 'pre'} onClick={() => setMode('pre')}>事前評価</button><button className="button secondary" aria-pressed={mode === 'paddock'} onClick={() => setMode('paddock')}>パドック評価</button></div>
      <section className="panel panel-body"><h2>{entry.number}番 {entry.horseName}</h2><p>{entry.status === 'ACTIVE' ? '出走予定' : `出走状態：${entry.status}`}</p>
        <label className="field">入力・変更理由<input aria-label="入力・変更理由" value={reason} maxLength={500} disabled={busy} onChange={e => setReason(e.target.value)} /></label>
        <fieldset disabled={busy || failed || !!conflict || !reason.trim()} className="assessment-fields">
          {mode === 'pre' ? <><div className="race-form-grid"><label className="field">事前点数<input aria-label="事前点数" type="number" min={0} max={100} value={content.preScore ?? ''} onChange={e => edit({ preScore: e.target.value === '' ? null : Number(e.target.value) })} /></label><label className="field">事前順位<input aria-label="事前順位" type="number" min={1} max={18} value={content.preRank ?? ''} onChange={e => edit({ preRank: e.target.value === '' ? null : Number(e.target.value) })} /></label><label className="field">事前印<select aria-label="事前印" value={content.preMark ?? ''} onChange={e => edit({ preMark: e.target.value ? e.target.value as AssessmentInput['preMark'] : null })}><option value="">未入力</option>{marks.map(m => <option key={m} value={m}>{markLabels[m]}</option>)}</select></label></div><label className="field">事前短評<textarea aria-label="事前短評" maxLength={1000} value={content.preComment} onChange={e => edit({ preComment: e.target.value })} /></label></> : <>
          {metrics.map(metric => <fieldset className="metric" key={metric}><legend>{metricLabels[metric]}</legend><div className="metric-options">{[1, 2, 3, 4, 5, 0].map(value => <button type="button" key={value} aria-label={`${metricLabels[metric]} ${value === 0 ? '判断不能' : value}`} aria-pressed={content[metric] === value} onClick={() => edit({ [metric]: value })}>{value === 0 ? '判断不能' : value}</button>)}</div></fieldset>)}
          <fieldset className="metric"><legend>総合変化</legend><div className="change-options">{changes.map(change => <button key={change} type="button" aria-pressed={content.change === change} onClick={() => edit({ change })}>{changeLabels[change]}</button>)}</div></fieldset>
          <label className="field">パドック短評<textarea aria-label="パドック短評" maxLength={1000} value={content.paddockComment} onChange={e => edit({ paddockComment: e.target.value })} placeholder="端末の音声入力も使用できます" /></label><div className="comment-templates">{['歩様がスムーズ', '落ち着いている', '判断材料が不足'].map(text => <button className="button secondary small" key={text} onClick={() => edit({ paddockComment: `${content.paddockComment}${content.paddockComment ? '。' : ''}${text}`.slice(0, 1000) })}>{text}</button>)}</div>
          </>}
        </fieldset>
      </section>
      <div className="horse-navigation"><button className="button secondary" disabled={index === 0} onClick={() => { setIndex(index - 1); setHistory([]); }}>前の馬</button><button className="button" disabled={index === workspace.entries.length - 1} onClick={() => { setIndex(index + 1); setHistory([]); }}>次の馬</button></div>
      <button className="text-link" onClick={() => void loadHistory()}>この馬の変更履歴</button>
      {history.length > 0 && <section className="panel panel-body"><h2>評価の変更履歴</h2>{history.map(item => <details key={item.revision}><summary>版{item.revision} · {new Date(item.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST · {item.reason}</summary><dl>{Object.entries(item.content).map(([key, value]) => <div key={key}><dt>{fieldLabels[key]}</dt><dd>{valueText(key, value)}</dd></div>)}</dl></details>)}<button disabled={historyPage === 1} onClick={() => void loadHistory(historyPage - 1)}>履歴の前へ</button><button disabled={historyPage * 20 >= historyTotal} onClick={() => void loadHistory(historyPage + 1)}>履歴の次へ</button></section>}
    </>}
    <button className="button secondary" onClick={() => setReview(!review)}>入力状況を確認</button>
    {review && <section className="panel panel-body"><h2>全頭の入力状況</h2>{(incomplete.length > 0 || pending > 0) && <p role="alert">未入力または未送信があります。</p>}<ul>{workspace.entries.map(e => <li key={e.id}>{e.number}番 {e.horseName}：事前 {preComplete(contentFor(e)) ? '入力済み' : '未入力あり'} / パドック {paddockComplete(contentFor(e)) ? '入力済み' : '未入力あり'} / {drafts[e.id] ? '未送信' : '保存済み'}</li>)}</ul><p>確認後、「最終予想・公開へ」から公開前プレビューへ進めます。</p></section>}
    <p className="muted form-note">入力はこの端末へ一時保存し、通信回復時に再同期します。共有端末での利用は避けてください。未送信の入力があるときは保存状態を確認してください。</p>
    <PredictionEditor raceId={raceId} />
  </div>;
}
