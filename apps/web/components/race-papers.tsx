'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { buildRacePaperNotice, jstDate, paperDisclaimer, type RacePaperDraft, type RacePaperList, type RacePaperPreview, type RacePaperRead, type RacePaperSnapshot, type RacePaperWorkspace } from '@keiba/domain';
import { PaidContentWatermark, type PaidContentViewer } from './paid-content-watermark';

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1/${path}`, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json(); if (!r.ok) throw new Error(data.message ?? '処理できませんでした。'); return data;
}
const time = (v: string) => new Date(v).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

export function PaperSheet({ snapshot }: { snapshot: RacePaperSnapshot }) {
  return <div className="paper-sheet"><h2>{snapshot.title}</h2><p>{snapshot.targetDate} ／ {snapshot.accessScope === 'MEMBERS' ? '登録会員向け' : '有料会員向け'}</p>{snapshot.summary && <p className="prediction-copy">{snapshot.summary}</p>}{snapshot.races.map(r => <section className="paper-race" key={r.raceId}><h3>{r.venue} {r.number}R {r.name}</h3><p className="muted">発走 {time(r.startsAt)} JST</p><ul className="paper-marks">{r.marks.map(m => <li key={m.entryId}><strong>{m.symbol}</strong><span>{m.number}・{m.horseName}{m.reason && <small>{m.reason}</small>}</span></li>)}</ul></section>)}<p className="muted form-note">{paperDisclaimer}</p></div>;
}

export function RacePaperManager() {
  const [items, setItems] = useState<{ id: string; title: string; targetDate: string; revision: number }[]>([]);
  const [saved, setSaved] = useState(false);
  const [id, setId] = useState(''); const [revision, setRevision] = useState(0);
  const [date, setDate] = useState(jstDate(new Date(Date.now() + 86400000))); const [title, setTitle] = useState('前日紙面予想');
  const [scope, setScope] = useState<'MEMBERS' | 'PAID'>('MEMBERS'); const [summary, setSummary] = useState(''); const [text, setText] = useState('');
  const [draft, setDraft] = useState<RacePaperDraft | null>(null); const [snapshot, setSnapshot] = useState<RacePaperSnapshot | null>(null);
  const [versions, setVersions] = useState<RacePaperWorkspace['versions']>([]); const [preview, setPreview] = useState<RacePaperPreview | null>(null);
  const [reason, setReason] = useState(''); const [correctionReason, setCorrectionReason] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function list() { setItems((await api<{ items: typeof items }>('expert/papers')).items); }
  useEffect(() => { list().catch(e => setError(e.message)); }, []);
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  function clear() { setDate(jstDate(new Date(Date.now() + 86400000))); setTitle('前日紙面予想'); setScope('MEMBERS'); setSummary(''); setSaved(false); setId(''); setRevision(0); setDraft(null); setSnapshot(null); setPreview(null); setVersions([]); setText(''); setReason(''); setCorrectionReason(''); setError(''); setMessage(''); }
  function invalidate() { setSaved(false); setDraft(null); setSnapshot(null); setPreview(null); }
  async function open(value: string) { await run(async () => {
    const s = await api<RacePaperWorkspace>(`expert/papers/${value}`); setId(s.id); setRevision(s.revision); setDate(s.draft.targetDate); setTitle(s.draft.title); setScope(s.draft.accessScope); setSummary(s.draft.summary); setDraft(s.draft); setSnapshot(s.snapshot); setVersions(s.versions); setPreview(null); setReason(''); setCorrectionReason('');
    setSaved(true); setText(s.snapshot.races.map(r => `${r.venue}\n${r.number}R ${r.name}\n${r.marks.map(m => `${m.symbol}${m.number}・${m.horseName}`).join('\n')}`).join('\n\n'));
  }); }
  async function importText() { await run(async () => {
    const result = await api<{ draft: RacePaperDraft; snapshot: RacePaperSnapshot }>('expert/papers/import', 'POST', { targetDate: date, title, accessScope: scope, summary, text });
    setSaved(false); setDraft(result.draft); setSnapshot(result.snapshot); setPreview(null); setMessage('原稿と登録済みレース・出走馬が一致しました。内容を確認して下書きを保存してください。');
  }); }
  async function save() { if (!draft) return; await run(async () => {
    const nextId = id || crypto.randomUUID(); const result = await api<{ id: string; revision: number }>('expert/papers/draft', 'POST', { id: nextId, revision, draft, reason });
    setSaved(true); setId(result.id); setRevision(result.revision); setPreview(null); await list(); setMessage('下書きを保存しました。続いて公開前確認へ進んでください。');
  }); }
  async function check() { await run(async () => { setPreview(await api<RacePaperPreview>(`expert/papers/${id}/preview`, 'POST', { revision, correctionReason })); }); }
  async function publish() { if (!preview) return; await run(async () => { await api(`expert/papers/${id}/publish/${preview.previewId}`, 'POST'); const s = await api<RacePaperWorkspace>(`expert/papers/${id}`); setVersions(s.versions); setPreview(null); await list(); setMessage('紙面を会員ページへ公開し、公開通知を登録しました。配送可否はサービス設定で決まります。'); }); }
  return <><div className="page-heading"><span className="eyebrow">RACE PAPER</span><h1>通常レース紙面を作成</h1><p>原稿を貼り付け、レース・馬名を照合して、複数レースを一枚にまとめて公開します。</p></div>
    {error && <div className="notice error prediction-copy" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <section className="panel panel-body"><h2>保存済み紙面</h2><button className="button secondary" disabled={busy} onClick={clear}>新しい紙面を作成</button>{items.map(p => <p key={p.id}><button className="text-link" disabled={busy} onClick={() => void open(p.id)}>{p.targetDate} {p.title}（下書き版{p.revision}）</button></p>)}</section>
    <section className="panel panel-body"><h2>1. 原稿を取り込む</h2><p>先に<Link href="/admin/races">レース・出走馬を登録</Link>してください。✕は原稿の推奨印として表示し、危険馬には変換しません。</p><div className="race-form-grid">
      <label className="field">対象日<input disabled={busy} type="date" value={date} onChange={e => { setDate(e.target.value); invalidate(); }} /></label>
      <label className="field">公開範囲<select disabled={busy} value={scope} onChange={e => { setScope(e.target.value as typeof scope); invalidate(); }}><option value="MEMBERS">登録会員全員（無料会員を含む）</option><option value="PAID">有料会員・対象日の1日利用者</option></select></label></div>
      <label className="field">紙面タイトル<input disabled={busy} value={title} maxLength={100} onChange={e => { setTitle(e.target.value); invalidate(); }} /></label>
      <label className="field">総評（任意）<textarea disabled={busy} rows={3} maxLength={5000} value={summary} onChange={e => { setSummary(e.target.value); invalidate(); }} /></label>
      <label className="field">紙面原稿<textarea disabled={busy} rows={15} maxLength={20000} value={text} placeholder={'東京\n9R 八ヶ岳特別\n◎4・フィールドノート\n○7・ミッキージャンプ\n▲8・ドッグウッド\n△2・イージーライダー\n△11・ホウオウシンデレラ'} onChange={e => { setText(e.target.value); invalidate(); }} /></label>
      <button className="button secondary" disabled={busy || !text.trim() || !title.trim()} onClick={() => void importText()}>原稿を読み取り・照合</button></section>
    {snapshot && <section className="panel panel-body"><h2>2. 内容を確認して保存</h2><PaperSheet snapshot={snapshot} /><label className="field">保存理由<input disabled={busy} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label><button className="button secondary" disabled={busy || !draft || !reason.trim()} onClick={() => void save()}>紙面の下書きを保存</button></section>}
    {id && revision > 0 && snapshot && <section className="panel panel-body"><h2>3. 公開前確認</h2><p>最初の対象レースの発走まで公開・訂正できます。公開した版は上書き・削除できません。</p>{versions.length > 0 && <label className="field">訂正理由<input disabled={busy} maxLength={500} value={correctionReason} onChange={e => { setCorrectionReason(e.target.value); setPreview(null); }} /></label>}<button className="button" disabled={busy || !draft || !saved || versions.length > 0 && !correctionReason.trim()} onClick={() => void check()}>紙面の公開内容を確認</button>
      {preview && <div className="import-preview"><h3>第{preview.version}版の公開確認</h3><p>締切：{time(preview.deadlineAt)} JST</p><PaperSheet snapshot={preview.snapshot} /><h3>LINE・メールの通知文面</h3><pre className="paper-notice">{preview.notificationText}</pre><p>通知には予想の印・馬番・馬名を含めず、会員ページへのリンクを送ります。LINE通知は公開モードと配信設定が有効な場合だけ送られます。</p><button className="button" disabled={busy} onClick={() => void publish()}>{busy ? '処理中…' : preview.version > 1 ? '紙面の訂正版を公開する' : '紙面を公開する'}</button></div>}</section>}
    {versions.length > 0 && <section className="panel panel-body"><h2>公開履歴</h2>{versions.map(v => <p key={v.id}>第{v.version}版：{time(v.publishedAt)} JST{v.correctionReason && ` ／ ${v.correctionReason}`}</p>)}<Link className="button secondary" href={`/papers/${id}`}>会員ページを確認</Link></section>}
  </>;
}

export function RacePaperArchive({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState<RacePaperList | null>(null); const [error, setError] = useState(''); const [page, setPage] = useState(1);
  useEffect(() => { api<RacePaperList>(`papers?page=${page}`).then(setValue).catch(e => setError(e.message)); }, [page]);
  return <section className="panel panel-body"><h1>{compact ? '通常レース紙面の新着' : '通常レース紙面'}</h1><p>前日に公開する馬の評価と、訂正履歴を確認できます。</p>{error && <p className="notice error" role="alert">{error}</p>}{!value && !error && <p role="status">紙面を読み込み中…</p>}{value && !value.items.length && <p>紙面はまだ公開されていません。</p>}{value?.items.slice(0, compact ? 3 : 20).map(p => <article className="paper-archive-item" key={p.id}><div><strong>{p.targetDate} {p.title}</strong><p>第{p.version}版 ／ {p.accessScope === 'MEMBERS' ? '登録会員向け' : '有料会員向け'}</p></div><Link className="button secondary small" href={`/papers/${p.id}`}>紙面を見る</Link></article>)}{compact ? <Link href="/papers" className="text-link">紙面一覧へ</Link> : value && <div className="panel-actions"><button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>前へ</button><span>{page}ページ</span><button className="button secondary" disabled={page * 20 >= value.total} onClick={() => setPage(page + 1)}>次へ</button></div>}</section>;
}

export function RacePaperPage({ id, viewer }: { id: string; viewer: PaidContentViewer }) {
  const [value, setValue] = useState<RacePaperRead | null>(null); const [error, setError] = useState(''); const [selected, setSelected] = useState(0); const [copied, setCopied] = useState(false);
  useEffect(() => { api<RacePaperRead>(`papers/${id}`).then(setValue).catch(e => setError(e.message)); }, [id]);
  const version = value?.versions[selected];
  async function copyNotice() { if (!version) return; try { await navigator.clipboard.writeText(buildRacePaperNotice({ id, title: version.title, targetDate: version.targetDate, version: version.version, appBaseUrl: window.location.origin }).text); setCopied(true); } catch { setError('コピーできませんでした。会員ページのURLをブラウザからコピーしてください。'); } }
  const paper = version && !version.locked ? <PaperSheet snapshot={version.snapshot} /> : null;
  return <><div className="page-heading"><h1>通常レース紙面予想</h1><Link href="/papers">紙面一覧へ</Link></div>{error && <div className="notice error" role="alert">{error}</div>}{!value && !error && <p role="status">紙面を読み込み中…</p>}{value && <section className="panel panel-body"><nav className="version-picker" aria-label="紙面の公開版">{value.versions.map((v, i) => <button className={`button ${selected === i ? '' : 'secondary'}`} key={v.id} onClick={() => setSelected(i)}>第{v.version}版</button>)}</nav>{version && <><p>公開：{time(version.publishedAt)} JST ／ {version.version > 1 ? '訂正あり' : '訂正なし'}</p>{version.correctionReason && <p>訂正理由：{version.correctionReason}</p>}{version.locked ? <div className="notice"><p>この紙面は有料会員向けです。</p><Link href="/plans">料金プランを確認</Link></div> : version.accessScope === 'PAID' ? <PaidContentWatermark viewer={viewer}>{paper}</PaidContentWatermark> : paper}<button className="button secondary" onClick={() => void copyNotice()}>公開案内をコピー</button>{copied && <p role="status">公開案内をコピーしました。</p>}</>}</section>}</>;
}
