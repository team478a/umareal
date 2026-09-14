'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { betTypes, confidences, emptyPredictionDraft, finalMarks, publicationVisibilities, stances, totalYenFor, type PredictionDraft } from '@keiba/domain';
import { RaceResultPanel } from './results';
import { FreeRaceReport } from './free-reports';
type Entry = { id: string; number: number; horseName: string; status: string; assessment?: { content: { change?: string | null; paddockComment?: string } } | null };
type Version = { id: string; version: number; status: string; visibility: string; confidence: string; stance: string; summary: string; estimatedTotalYen: number; publishedAt: string; correctionReason: string | null; marks: { id?: string; entryId: string; horseNumber: number; horseName: string; mark: string; reason: string }[]; bets: { id: string; betType: string; combination: number[][]; amountPerPointYen: number; points: number; totalYen: number }[] };
type PublicVersion = { id: string; version: number; status: string; visibility: string; publishedAt: string; previousVersionId?: string | null; locked: boolean } & Partial<Version>;
type State = { race: { id: string; name: string; venue: string; number: number; startsAt: string; status: string; revision: number }; entries: Entry[]; prediction: { id: string; revision: number; draft: PredictionDraft } | null; versions: Version[]; correctionPolicy: string };
type Preview = { previewId: string; expiresAt: string; version: number; correction: boolean; correctionReason: string; warnings: string[]; totalYen: number; points: number; deadlineAt: string; draft: PredictionDraft; entries: Entry[] };
const markLabels: Record<string, string> = { HONMEI: '◎ 本命', TAIKO: '○ 対抗', TANANA: '▲ 単穴', RENKA: '△ 連下', ANA: '☆ 穴', DANGER: '危険馬' };
const stanceLabels: Record<string, string> = { BET: '勝負', NORMAL: '通常', SMALL: '少額', SKIP: '見送り' };
const betLabels: Record<string, string> = { WIN: '単勝', PLACE: '複勝', QUINELLA: '馬連', EXACTA: '馬単', WIDE: 'ワイド', TRIO: '三連複', TRIFECTA: '三連単' };
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/expert/races/${path}`, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理できませんでした。'); return result;
}
function parseBets(source: string): PredictionDraft['bets'] {
  if (!source.trim()) return [];
  return source.split(/\r?\n/).map((raw, index) => {
    const parts = raw.split(',').map(value => value.trim());
    if (parts.length !== 3 || !betTypes.includes(parts[0] as typeof betTypes[number])) throw new Error(`${index + 1}行目は「券種,組合せ,1点金額」で入力してください。`);
    const combinations = parts[1].split('/').map(group => group.split('-').map(Number)); const amountPerPointYen = Number(parts[2]);
    return { type: parts[0] as typeof betTypes[number], combinations, amountPerPointYen };
  });
}
function betsText(draft: PredictionDraft) { return draft.bets.map(bet => `${bet.type},${bet.combinations.map(c => c.join('-')).join('/')},${bet.amountPerPointYen}`).join('\n'); }
export function PredictionEditor({ raceId }: { raceId: string }) {
  const [state, setState] = useState<State | null>(null); const [draft, setDraft] = useState<PredictionDraft>(emptyPredictionDraft); const [revision, setRevision] = useState(0);
  const [bets, setBets] = useState(''); const [reason, setReason] = useState('最終予想の編集'); const [correctionReason, setCorrectionReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false); const [open, setOpen] = useState(false);
  async function load() {
    setError(''); try { const result = await request<State>(`${raceId}/prediction`); setState(result); const value = result.prediction?.draft ?? emptyPredictionDraft; setDraft(value); setBets(betsText(value)); setRevision(result.prediction?.revision ?? 0); setDirty(false); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [raceId]);
  const parsedBets = useMemo(() => { try { return parseBets(bets); } catch { return []; } }, [bets]);
  const localTotal = totalYenFor({ ...draft, bets: parsedBets });
  function change(patch: Partial<PredictionDraft>) { setDraft(current => ({ ...current, ...patch })); setDirty(true); setPreview(null); setMessage(''); }
  function mark(entryId: string, value: string) {
    const remaining = draft.marks.filter(item => item.entryId !== entryId);
    change({ marks: value ? [...remaining, { entryId, mark: value as typeof finalMarks[number], reason: draft.marks.find(item => item.entryId === entryId)?.reason ?? '' }] : remaining });
  }
  function markReason(entryId: string, value: string) { change({ marks: draft.marks.map(item => item.entryId === entryId ? { ...item, reason: value } : item) }); }
  async function saveDraft() {
    if (!state) throw new Error('レース情報を再読み込みしてください。');
    const next = { ...draft, bets: draft.stance === 'SKIP' ? [] : parseBets(bets) };
    const saved = await request<{ revision: number; draft: PredictionDraft }>(`${raceId}/prediction/draft`, 'POST', { draft: next, revision, raceRevision: state.race.revision, mutationId: crypto.randomUUID(), reason });
    setDraft(saved.draft); setBets(betsText(saved.draft)); setRevision(saved.revision); setDirty(false); setMessage('下書きを保存しました。'); return saved.revision;
  }
  async function save() { setBusy(true); setError(''); try { await saveDraft(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function check() {
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try { const savedRevision = dirty || revision === 0 ? await saveDraft() : revision; setPreview(await request<Preview>(`${raceId}/prediction/preview`, 'POST', { predictionRevision: savedRevision, raceRevision: state!.race.revision, correctionReason })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setError(''); try { const result = await request<{ version: number }>(`${raceId}/prediction/publish/${preview!.previewId}`, 'POST'); setPreview(null); await load(); setMessage(`公開版${result.version}を保存しました。`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!state) return <section className="panel panel-body"><h2>最終予想</h2><p role={error ? 'alert' : 'status'}>{error || '読み込み中…'}</p></section>;
  const correcting = state.versions.length > 0;
  return <section className="prediction-editor"><button className="button" onClick={() => setOpen(!open)}>{open ? '評価入力に戻る' : '最終予想・公開へ'}</button>{open && <div className="prediction-stack">
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">FINAL PREDICTION</span><h2>最終予想の下書き</h2></div><span className="status-tag">下書き版 {revision || '未保存'}</span></div><div className="panel-body">
      {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
      {correcting && <div className="notice">公開済みです。次の公開は訂正版として新しい版を追加します。</div>}
      <div className="race-form-grid"><label className="field">公開範囲<select aria-label="公開範囲" value={draft.visibility ?? ''} onChange={e => change({ visibility: e.target.value as PredictionDraft['visibility'] })}><option value="">未選択</option>{publicationVisibilities.map(value => <option key={value} value={value}>{value === 'FREE' ? '無料公開' : '有料会員'}</option>)}</select></label><label className="field">信頼度<select aria-label="信頼度" value={draft.confidence ?? ''} onChange={e => change({ confidence: e.target.value as PredictionDraft['confidence'] })}><option value="">未選択</option>{confidences.map(value => <option key={value}>{value}</option>)}</select></label><label className="field">勝負判断<select aria-label="勝負判断" value={draft.stance ?? ''} onChange={e => { const stance = e.target.value as PredictionDraft['stance']; change({ stance, ...(stance === 'SKIP' ? { bets: [] } : {}) }); if (stance === 'SKIP') setBets(''); }}><option value="">未選択</option>{stances.map(value => <option key={value} value={value}>{stanceLabels[value]}</option>)}</select></label></div>
      <label className="field">総評<textarea aria-label="総評" rows={5} maxLength={5000} value={draft.summary} onChange={e => change({ summary: e.target.value })} /></label>
      <h3>最終印</h3><div className="table-scroll"><table className="race-data-table"><thead><tr><th>馬</th><th>パドック変化</th><th>最終印</th><th>理由</th></tr></thead><tbody>{state.entries.map(entry => { const selected = draft.marks.find(item => item.entryId === entry.id); return <tr key={entry.id}><td>{entry.number}番 {entry.horseName}{entry.status !== 'ACTIVE' && `（${entry.status}）`}</td><td>{entry.assessment?.content.change ?? '未入力'}<br /><small>{entry.assessment?.content.paddockComment}</small></td><td><select aria-label={`${entry.number}番の最終印`} disabled={entry.status !== 'ACTIVE'} value={selected?.mark ?? ''} onChange={e => mark(entry.id, e.target.value)}><option value="">印なし</option>{finalMarks.map(value => <option value={value} key={value}>{markLabels[value]}</option>)}</select></td><td><input aria-label={`${entry.number}番の印の理由`} disabled={!selected} maxLength={500} value={selected?.reason ?? ''} onChange={e => markReason(entry.id, e.target.value)} /></td></tr>; })}</tbody></table></div>
      <h3>参考買い目</h3><label className="field">買い目CSV<textarea aria-label="参考買い目" rows={5} disabled={draft.stance === 'SKIP'} value={bets} onChange={e => { setBets(e.target.value); setDirty(true); setPreview(null); }} placeholder={'EXACTA,1-2/1-3,500\nWIN,1,1000'} /></label><p className="muted form-note">1行ごとに「券種,組合せ（/区切り）,1点金額」。券種：{betTypes.join(' / ')}。金額は100円単位です。</p><div className="prediction-total"><span>想定点数 {parsedBets.reduce((sum, bet) => sum + bet.combinations.length, 0)}点</span><strong>想定購入総額 {localTotal.toLocaleString('ja-JP')}円</strong></div>
      <label className="field">下書きの変更理由<input aria-label="下書きの変更理由" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {correcting && <label className="field">訂正理由<input aria-label="訂正理由" maxLength={500} value={correctionReason} onChange={e => { setCorrectionReason(e.target.value); setPreview(null); }} /></label>}
      {correcting && state.correctionPolicy === 'ADMIN_ONLY' && <p className="muted form-note">現在の開発設定では、訂正版の公開前確認と確定は管理者が行います。</p>}
      <div className="panel-actions"><button className="button secondary" disabled={busy || !reason.trim()} onClick={() => void save()}>{busy ? '処理中…' : '下書きを保存'}</button><button className="button" disabled={busy || !reason.trim() || (correcting && !correctionReason.trim())} onClick={() => void check()}>公開前に確認</button></div>
    </div></section>
    {preview && <section className="panel publish-preview"><div className="panel-heading"><div><span className="eyebrow">PUBLICATION REVIEW</span><h2>{preview.correction ? `訂正版 ${preview.version}` : `初版 ${preview.version}`}の公開前確認</h2></div></div><div className="panel-body"><p>公開範囲：{preview.draft.visibility === 'FREE' ? '無料公開' : '有料会員'} ／ 信頼度：{preview.draft.confidence} ／ 判断：{stanceLabels[preview.draft.stance!]}</p><p>締切：{new Date(preview.deadlineAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>{preview.correction && <p>訂正理由：{preview.correctionReason}</p>}{preview.warnings.length > 0 && <div className="notice error" role="alert">{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}<h3>総評</h3><p>{preview.draft.summary}</p><h3>最終印</h3><ul>{preview.draft.marks.map(mark => { const entry = preview.entries.find(e => e.id === mark.entryId)!; return <li key={mark.entryId}>{markLabels[mark.mark]}：{entry.number}番 {entry.horseName}{mark.reason && ` — ${mark.reason}`}</li>; })}</ul><h3>参考買い目</h3>{preview.draft.stance === 'SKIP' ? <p>見送り（買い目なし）</p> : <ul>{preview.draft.bets.map((bet, index) => <li key={index}>{betLabels[bet.type]} {bet.combinations.map(c => c.join('-')).join(' / ')} · {bet.amountPerPointYen.toLocaleString()}円 × {bet.combinations.length}点</li>)}</ul>}<div className="prediction-total"><span>{preview.points}点</span><strong>{preview.totalYen.toLocaleString()}円</strong></div><button className="button publish-button" disabled={busy} onClick={() => void publish()}>{busy ? '公開中…' : preview.correction ? '訂正版を公開する' : '最終予想を公開する'}</button><p className="muted form-note">公開後はこの版を変更・削除できません。訂正は新しい版として残ります。</p></div></section>}
    {state.versions.length > 0 && <section className="panel"><div className="panel-heading"><h2>公開履歴</h2></div><div className="panel-body">{state.versions.map(version => <details key={version.id}><summary>版{version.version} · {version.status === 'CORRECTED' ? '訂正版' : '初版'} · {new Date(version.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</summary><p>{version.correctionReason && `訂正理由：${version.correctionReason}`}</p><p>{version.summary}</p><p>{version.estimatedTotalYen.toLocaleString()}円</p></details>)}</div></section>}
  </div>}</section>;
}

type PublicResult = { race: { id: string; name: string; venue: string; number: number; startsAt: string }; latest: PublicVersion | null; versions: PublicVersion[]; total: number; locked: boolean };
export function PublishedPrediction({ raceId }: { raceId: string }) {
  const [result, setResult] = useState<PublicResult | null>(null); const [error, setError] = useState(''); const [selected, setSelected] = useState(0);
  useEffect(() => { fetch(`/api/v1/races/${raceId}/prediction`, { cache: 'no-store' }).then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.message); setResult(value); }).catch(e => setError(e.message)); }, [raceId]);
  if (error) return <div className="notice error" role="alert">{error}</div>;
  if (!result) return <p role="status">予想を読み込み中…</p>;
  const version = result.versions[selected];
  return <><div className="page-heading"><span className="eyebrow">PREDICTION</span><h1>{result.race.name}</h1><p>{result.race.venue} {result.race.number}R · {new Date(result.race.startsAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p></div><FreeRaceReport raceId={raceId} />{!result.latest ? <section className="panel panel-body prediction-gate"><h2>最終予想は未公開です</h2><p>公開後にこちらで確認できます。LINE通知を設定すると、対象レース告知と公開のお知らせを受け取れます。</p><div className="gate-actions"><Link className="button" href="/account">LINE通知を確認</Link><Link className="button secondary" href="/plans">料金プランを見る</Link></div></section> : <><nav className="version-picker" aria-label="公開版選択">{result.versions.map((item, index) => <button className={`button ${selected === index ? '' : 'secondary'}`} key={item.id} onClick={() => setSelected(index)}>版{item.version}{item.status === 'CORRECTED' ? ' 訂正' : ''}</button>)}</nav>{version?.locked ? <section className="panel panel-body prediction-gate"><h2>有料会員向けの最終予想です</h2><p>版{version.version}は公開済みです。料金と申込内容を確認すると閲覧へ進めます。</p><div className="gate-actions"><Link className="button" href="/plans">料金プランを確認</Link><Link className="button secondary" href="/account">会員状態を確認</Link></div></section> : version ? <VersionView version={version as Version} /> : null}</>}<RaceResultPanel raceId={raceId} /></>;
}
function VersionView({ version }: { version: Version }) {
  return <section className="panel published-prediction"><div className="panel-heading"><div><span className="eyebrow">{version.visibility === 'FREE' ? 'FREE' : 'MEMBERS ONLY'}</span><h2>最終予想 · 版{version.version}</h2></div><span className="status-tag">{version.status === 'CORRECTED' ? '訂正版' : '初版'}</span></div><div className="panel-body"><p className="muted">公開：{new Date(version.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>{version.correctionReason && <div className="notice">訂正理由：{version.correctionReason}</div>}<div className="prediction-summary"><span>信頼度 {version.confidence}</span><span>{stanceLabels[version.stance]}</span></div><h3>総評</h3><p className="prediction-copy">{version.summary}</p><h3>最終印</h3><ul className="published-marks">{version.marks.map(mark => <li key={mark.id ?? mark.entryId}><strong>{markLabels[mark.mark]}</strong><span>{mark.horseNumber}番 {mark.horseName}</span><small>{mark.reason}</small></li>)}</ul><h3>参考買い目</h3>{version.stance === 'SKIP' ? <p>見送り</p> : <ul>{version.bets.map(bet => <li key={bet.id}>{betLabels[bet.betType]} {bet.combination.map(c => c.join('-')).join(' / ')} · {bet.amountPerPointYen.toLocaleString()}円 × {bet.points}点</li>)}</ul>}<div className="prediction-total"><span>想定購入総額</span><strong>{version.estimatedTotalYen.toLocaleString()}円</strong></div><p className="muted form-note">参考情報です。馬券の購入判断と操作は利用者本人が行います。</p></div></section>;
}
