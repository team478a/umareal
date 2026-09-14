'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowRight, Eye, FileUp, Plus, RefreshCw } from 'lucide-react';
import { entryHeaders, entryStatuses, jstDate, raceHeaders, raceStatuses, venues, type EntryInput, type ImportKind, type RaceInput } from '@keiba/domain';
import { NotificationPreview, type RaceAnnouncementPreview } from './notification-preview';

type Entry = Omit<EntryInput, 'carriedWeight' | 'winOdds'> & { id: string; carriedWeight: string | number; winOdds: string | number | null };
type Race = Omit<RaceInput, 'expertId'> & { id: string; revision: number; entries?: Entry[]; announcements?: { id: string; version: number; publishedAt: string }[]; assignments: { userId: string; user?: { displayName: string } }[]; _count?: { entries: number } };
type Expert = { id: string; displayName: string };
type Day = { id: string; raceDate: string; venue: string; _count: { races: number } };
type Preview = { batchId: string | null; expiresAt?: string; errors: { row: number; field: string; message: string }[]; changes: { key: string; action: string; fields: { field: string; before: unknown; after: unknown }[] }[] };
const labels: Record<string, string> = { raceDate: '開催日', venue: '競馬場', number: '番号', name: 'レース名', raceClass: 'クラス', distance: '距離（m）', surface: '馬場', direction: 'コース', startsAt: '発走日時（JST）', going: '馬場状態', weather: '天候', status: '状態', expertId: '担当専門家', horseId: '馬ID', gate: '枠番', horseName: '馬名', sex: '性別', age: '年齢', carriedWeight: '斤量（kg）', jockey: '騎手', trainer: '調教師', winOdds: '単勝オッズ', popularity: '人気' };
const choices: Record<string, Record<string, string>> = {
  surface: { TURF: '芝', DIRT: 'ダート' }, direction: { RIGHT: '右回り', LEFT: '左回り', STRAIGHT: '直線' },
  going: { UNKNOWN: '未確認', GOOD: '良', YIELDING: '稍重', SOFT: '重', HEAVY: '不良' },
  status: { SCHEDULED: '開催予定', ACTIVE: '進行中', DELAYED: '発走延期', FINISHED: '終了', CANCELLED: '開催中止', SCRATCHED: '取消', EXCLUDED: '除外', STOPPED: '競走中止' },
  sex: { MALE: '牡', FEMALE: '牝', GELDING: '騸' }
};
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/admin/${path}`, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.message ?? '処理できませんでした。'}${result.details ? ' ' + result.details.map((d: { path: string; message: string }) => `${labels[d.path.split('.').pop() ?? ''] ?? d.path}: ${d.message}`).join(' / ') : ''}`);
  return result;
}
function ErrorMessage({ error }: { error: string }) { return error ? <div className="notice error" role="alert">{error}</div> : null; }
async function loadExperts(): Promise<{ items: Expert[] }> {
  const first = await request<{ items: Expert[]; total: number }>('race-experts?limit=50');
  const rest = await Promise.all(Array.from({ length: Math.max(0, Math.ceil(first.total / 50) - 1) }, (_, i) => request<{ items: Expert[] }>(`race-experts?limit=50&page=${i + 2}`)));
  return { items: [...first.items, ...rest.flatMap(result => result.items)] };
}
function Pager({ page, total, setPage, limit = 20 }: { page: number; total: number; setPage: (page: number) => void; limit?: number }) {
  return <div className="pagination"><span>全{total}件 · {page}ページ</span><button className="button secondary small" disabled={page === 1} onClick={() => setPage(page - 1)}>前へ</button><button className="button secondary small" disabled={page * limit >= total} onClick={() => setPage(page + 1)}>次へ</button></div>;
}
function Field({ name, label, value, type = 'text', required = true, options, step }: { name: string; label?: string; value?: string | number | null; type?: string; required?: boolean; options?: Record<string, string>; step?: string }) {
  const labelId = useId();
  return <label className="field"><span id={labelId}>{label ?? labels[name]}</span>{options ? <select aria-labelledby={labelId} name={name} defaultValue={value ?? ''} required={required}>{Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select> : <input aria-labelledby={labelId} name={name} defaultValue={value ?? ''} type={type} required={required} step={step} maxLength={type === 'text' ? 100 : undefined} />}</label>;
}

export function RaceManager() {
  const [date, setDate] = useState(jstDate(new Date())); const [days, setDays] = useState<Day[]>([]); const [dayPage, setDayPage] = useState(1); const [dayTotal, setDayTotal] = useState(0);
  const [races, setRaces] = useState<Race[]>([]); const [experts, setExperts] = useState<Expert[]>([]); const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Race | null>(null); const [editing, setEditing] = useState(false); const [entry, setEntry] = useState<Entry | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [announcementReasons, setAnnouncementReasons] = useState<Record<string, string>>({});
  const [announcementPreview, setAnnouncementPreview] = useState<RaceAnnouncementPreview | null>(null); const [previewBusy, setPreviewBusy] = useState('');
  const load = useCallback(async () => {
    try { const [r, d, e] = await Promise.all([request<{ items: Race[]; total: number }>(`races?date=${date}&page=${page}`), request<{ items: Day[]; total: number }>(`race-days?page=${dayPage}`), loadExperts()]); setRaces(r.items); setTotal(r.total); setDays(d.items); setDayTotal(d.total); setExperts(e.items); }
    catch (e) { setError((e as Error).message); }
  }, [date, page, dayPage]);
  useEffect(() => { void load(); }, [load]);
  async function open(id: string) { setError(''); try { setSelected(await request<Race>(`races/${id}`)); setEntry(null); setEditing(true); } catch (e) { setError((e as Error).message); } }
  async function previewAnnouncement(race: Race) { setPreviewBusy(race.id); setError(''); setMessage(''); try { setAnnouncementPreview(await request<RaceAnnouncementPreview>(`notifications/previews/race-announcement?raceId=${race.id}`)); } catch (e) { setError((e as Error).message); } finally { setPreviewBusy(''); } }
  async function announce(race: Race) { const reason = announcementReasons[race.id]?.trim(); if (!reason) { setError('告知理由を入力してください。'); return; } setBusy(true); setError(''); setMessage(''); try { const result = await request<{ version: number }>(`races/${race.id}/announce`, 'POST', { reason }); setAnnouncementReasons({ ...announcementReasons, [race.id]: '' }); setAnnouncementPreview(null); setMessage(`${race.venue} ${race.number}Rを告知しました（第${result.version}版）。`); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function saveDay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try { const day = { raceDate: String(form.get('raceDate')), venue: String(form.get('venue')) }; await request('race-days', 'POST', { day, reason: form.get('reason') }); setDate(day.raceDate); setMessage('開催日を登録しました。'); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><span className="eyebrow">RACE OPERATIONS</span><h1>レース管理</h1><p>開催日・出走馬・担当者を登録し、CSVの差分を確認して取り込みます。</p></div>
    <ErrorMessage error={error} />{message && <div className="notice" role="status">{message}</div>}
    <section className="panel"><div className="panel-heading"><h2>開催日</h2></div><form onSubmit={saveDay} className="panel-body"><div className="race-form-grid"><Field name="raceDate" type="date" value={date} /><Field name="venue" value="東京" options={Object.fromEntries(venues.map(v => [v, v]))} /><Field name="reason" label="開催日の登録理由" /><div className="field-action"><button className="button" disabled={busy}><Plus size={16} />開催日を登録</button></div></div></form>
      <div className="day-list">{days.map(day => <button key={day.id} className={`day-chip ${day.raceDate === date ? 'selected' : ''}`} onClick={() => { setDate(day.raceDate); setPage(1); setEditing(false); setSelected(null); }}>{day.raceDate} · {day.venue}<small>{day._count.races} レース</small></button>)}</div><Pager page={dayPage} total={dayTotal} setPage={setDayPage} />
    </section>
    <section className="panel"><div className="panel-heading race-toolbar"><h2>登録レース</h2><label className="date-filter">表示する開催日<input aria-label="表示する開催日" type="date" value={date} onChange={e => { setDate(e.target.value); setPage(1); setEditing(false); setSelected(null); }} /></label><button className="button" onClick={() => { setSelected(null); setEntry(null); setEditing(true); }}><Plus size={16} />レースを追加</button></div>
      {races.length > 0 && <div className="announcement-quick-list"><div className="quick-list-heading"><strong>対象レース告知</strong><small>対象人数と本文を確認してから公開します。</small></div>{races.map(race => <div className="announcement-quick-row" key={race.id}><div><strong>{race.venue} {race.number}R {race.name}</strong><small>{race.announcements?.[0] ? `告知済み・第${race.announcements[0].version}版` : '未告知'}</small></div><label className="field"><span className="sr-only">{race.name}の告知理由</span><input aria-label={`${race.name}の告知理由`} value={announcementReasons[race.id] ?? ''} maxLength={500} onChange={event => setAnnouncementReasons({ ...announcementReasons, [race.id]: event.target.value })} placeholder="対象レースとして決定" /></label><button className="button secondary small" disabled={busy || previewBusy === race.id || !(announcementReasons[race.id] ?? '').trim()} onClick={() => void previewAnnouncement(race)}><Eye size={16} />{previewBusy === race.id ? '確認中…' : '配信内容を確認'}</button>{announcementPreview?.race.id === race.id && <NotificationPreview preview={announcementPreview} busy={busy} action={{ label: race.announcements?.[0] ? 'この内容で再告知する' : 'この内容で告知する', onClick: () => void announce(race) }} />}</div>)}</div>}
      {races.length ? <div className="table-scroll"><table className="race-data-table"><thead><tr><th>レース</th><th>発走（JST）</th><th>状態</th><th>出走馬</th><th>担当専門家</th><th>操作</th></tr></thead><tbody>{races.map(r => <tr key={r.id}><td>{r.venue} {r.number}R<br /><strong>{r.name}</strong></td><td>{new Date(r.startsAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}</td><td>{choices.status[r.status]}</td><td>{r._count?.entries ?? 0}頭</td><td>{r.assignments.map(a => a.user?.displayName ?? a.userId).join('、') || '未割当'}</td><td><button className="button secondary small" onClick={() => void open(r.id)}>編集・出走馬</button></td></tr>)}</tbody></table></div> : <div className="empty"><h3>この日のレースは未登録です</h3><p>レースを追加するか、CSVを取り込んでください。</p></div>}<Pager page={page} total={total} setPage={setPage} />
    </section>
    {editing && <RaceEditor key={selected ? `${selected.id}-${selected.revision}` : `new-${date}`} race={selected} date={date} experts={experts} onSaved={async r => { setSelected(r); setMessage('レース情報を保存しました。'); await load(); }} onReload={() => selected && void open(selected.id)} />}
    {selected && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">{selected.venue} {selected.number}R · {selected.name}</span><h2>出走馬</h2></div><button className="button secondary small" onClick={() => setEntry(null)}>新しい馬を入力</button></div>
      <div className="table-scroll"><table className="race-data-table"><thead><tr><th>馬番 / 枠</th><th>馬名</th><th>性齢 / 斤量</th><th>騎手</th><th>状態</th><th>操作</th></tr></thead><tbody>{selected.entries?.map(e => <tr key={e.id}><td>{e.number} / {e.gate}</td><td>{e.horseName}</td><td>{choices.sex[e.sex]}{e.age} · {e.carriedWeight}kg</td><td>{e.jockey}</td><td>{e.status === 'ACTIVE' ? '出走予定' : choices.status[e.status]}</td><td><button className="button secondary small" onClick={() => setEntry(e)}>編集</button></td></tr>)}</tbody></table></div>
      <EntryEditor key={`${selected.id}-${selected.revision}-${entry?.id ?? 'new'}`} race={selected} entry={entry} onSaved={async () => { await open(selected.id); await load(); setMessage('出走馬を保存しました。'); }} />
    </section>}
    <CsvImport key={selected?.id ?? 'races'} race={selected} onConfirmed={async () => { await load(); if (selected) await open(selected.id); }} />
  </>;
}

function RaceEditor({ race, date, experts, onSaved, onReload }: { race: Race | null; date: string; experts: Expert[]; onSaved: (race: Race) => Promise<void>; onReload: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const input: Record<string, unknown> = Object.fromEntries(raceHeaders.map(key => [key, data[key]]));
      input.number = Number(input.number); input.distance = Number(input.distance); input.expertId = input.expertId || null;
      input.startsAt = new Date(`${input.startsAt}:00+09:00`).toISOString();
      const result = await request<Race>(race ? `races/${race.id}` : 'races', race ? 'PATCH' : 'POST', { race: input, reason: data.reason, ...(race ? { revision: race.revision } : {}) });
      await onSaved(result);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const localStart = race ? new Date(new Date(race.startsAt).getTime() + 9 * 3600000).toISOString().slice(0, 16) : `${date}T15:00`;
  return <section className="panel"><div className="panel-heading"><h2>{race ? 'レース情報の編集' : '新しいレース'}</h2>{race && <button className="text-link" onClick={onReload}><RefreshCw size={16} />再読み込み</button>}</div><form className="panel-body" onSubmit={save}><ErrorMessage error={error} /><div className="race-form-grid">
    <Field name="raceDate" type="date" value={race?.raceDate ?? date} /><Field name="venue" value={race?.venue ?? '東京'} options={Object.fromEntries(venues.map(v => [v, v]))} /><Field name="number" label="レース番号" type="number" value={race?.number ?? 1} />
    <Field name="name" value={race?.name} /><Field name="raceClass" value={race?.raceClass} /><Field name="distance" type="number" value={race?.distance ?? 1600} />
    <Field name="surface" value={race?.surface ?? 'TURF'} options={choices.surface} /><Field name="direction" value={race?.direction ?? 'LEFT'} options={choices.direction} /><Field name="startsAt" type="datetime-local" value={localStart} />
    <Field name="going" value={race?.going ?? 'UNKNOWN'} options={choices.going} /><Field name="weather" value={race?.weather ?? '未確認'} /><Field name="status" value={race?.status ?? 'SCHEDULED'} options={Object.fromEntries(raceStatuses.map(s => [s, choices.status[s]]))} />
    <Field name="expertId" value={race?.assignments[0]?.userId ?? ''} required={false} options={{ '': '未割当', ...Object.fromEntries(experts.map(e => [e.id, e.displayName])) }} /><Field name="reason" label="レースの登録・変更理由" />
  </div>{race && <p className="muted form-note">開催日・競馬場・レース番号は変更できません。発走時刻の変更は履歴に記録されます。</p>}<button className="button" disabled={busy}>{busy ? '保存中…' : 'レースを保存'}<ArrowRight size={16} /></button></form></section>;
}

function EntryEditor({ race, entry, onSaved }: { race: Race; entry: Entry | null; onSaved: () => Promise<void> }) {
  const [horseId] = useState(() => entry?.horseId ?? crypto.randomUUID()); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const input: Record<string, unknown> = Object.fromEntries(entryHeaders.map(key => [key, data[key]]));
      for (const key of ['number', 'gate', 'age', 'carriedWeight', 'winOdds', 'popularity']) input[key] = input[key] === '' ? null : Number(input[key]);
      await request(`races/${race.id}/entries`, 'POST', { entry: input, ...(entry ? { entryId: entry.id } : {}), revision: race.revision, reason: data.reason }); await onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <form className="panel-body entry-editor" onSubmit={save}><h3>{entry ? `${entry.number}番の編集` : '出走馬を追加'}</h3><ErrorMessage error={error} /><div className="race-form-grid">
    <Field name="number" label="馬番" type="number" value={entry?.number ?? Array.from({ length: 18 }, (_, i) => i + 1).find(n => !race.entries?.some(e => e.number === n))} /><Field name="gate" type="number" value={entry?.gate ?? 1} /><Field name="horseName" value={entry?.horseName} />
    <Field name="horseId" value={horseId} /><Field name="sex" value={entry?.sex ?? 'MALE'} options={choices.sex} /><Field name="age" type="number" value={entry?.age ?? 3} />
    <Field name="carriedWeight" type="number" step="0.1" value={entry?.carriedWeight ?? 57} /><Field name="jockey" value={entry?.jockey} /><Field name="trainer" value={entry?.trainer} />
    <Field name="winOdds" type="number" step="0.1" required={false} value={entry?.winOdds} /><Field name="popularity" type="number" required={false} value={entry?.popularity} /><Field name="status" value={entry?.status ?? 'ACTIVE'} options={Object.fromEntries(entryStatuses.map(s => [s, s === 'ACTIVE' ? '出走予定' : choices.status[s]]))} />
    <Field name="reason" label="出走馬の登録・変更理由" />
  </div><p className="muted form-note">既存の馬は同じ馬IDを使ってください。登録済みの馬は一覧の「編集」から変更します。取消・除外は状態を変更して記録します。</p><button className="button" disabled={busy}>{busy ? '保存中…' : '出走馬を保存'}</button></form>;
}

function CsvImport({ race, onConfirmed }: { race: Race | null; onConfirmed: () => Promise<void> }) {
  const [kind, setKind] = useState<ImportKind>(race ? 'entries' : 'races'); const [csv, setCsv] = useState(''); const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try { setPreview(await request<Preview>('races/import/preview', 'POST', { kind, csv, ...(kind === 'entries' ? { raceId: race?.id } : {}) })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setError('');
    try { await request(`races/import/${preview!.batchId}/confirm`, 'POST', { reason }); setPreview(null); setMessage('CSVの取込を確定しました。'); await onConfirmed(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function fileChanged(file?: File) {
    setPreview(null); setError(''); if (!file) return;
    if (file.size > 65536) { setError('CSVは64KB以内にしてください。'); return; }
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); setCsv(text); }
    catch { setError('UTF-8形式のCSVを選択してください。'); }
  }
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">CSV IMPORT</span><h2>CSV取込</h2></div><FileUp size={22} /></div><div className="panel-body"><ErrorMessage error={error} />{message && <div className="notice" role="status">{message}</div>}
    <div className="race-form-grid"><label className="field">取込対象<select aria-label="取込対象" value={kind} onChange={e => { setKind(e.target.value as ImportKind); setCsv(''); setPreview(null); }}><option value="races">レース情報</option><option value="entries" disabled={!race}>出走馬{race ? `（${race.venue} ${race.number}R）` : '（レースを選択してください）'}</option></select></label><label className="field">CSVファイル<input type="file" accept=".csv,text/csv" onChange={e => void fileChanged(e.target.files?.[0])} /></label><a className="text-link" href={`/samples/${kind}.csv`} download>サンプルCSVをダウンロード</a></div>
    <label className="field">CSVの内容<textarea aria-label="CSVの内容" rows={6} value={csv} onChange={e => { setCsv(e.target.value); setPreview(null); }} placeholder={(kind === 'races' ? raceHeaders : entryHeaders).join(',')} /></label><p className="muted form-note">UTF-8・200行以内。CSVにないレースや出走馬は削除しません。空の担当専門家は未割当への変更として扱います。</p>
    <button className="button secondary" disabled={busy || !csv.trim()} onClick={() => void check()}>{busy ? '確認中…' : '差分を確認'}</button>
    {preview && <div className="import-preview"><h3>取込前の確認</h3>{preview.errors.length ? <div role="alert"><ul>{preview.errors.map((e, i) => <li key={i}>{e.row}行目 · {labels[e.field] ?? e.field}：{e.message}</li>)}</ul></div> : <>
      <p className="muted form-note">追加 {preview.changes.filter(c => c.action === '追加').length}件 ／ 変更 {preview.changes.filter(c => c.action === '変更').length}件 ／ 変更なし {preview.changes.filter(c => c.action === '変更なし').length}件</p>
      {preview.changes.map((change, i) => <details key={i} open={change.action === '変更'}><summary><span className="status-tag">{change.action}</span> {change.key}</summary><div className="table-scroll"><table className="race-data-table"><thead><tr><th>項目</th><th>現在</th><th>取込後</th></tr></thead><tbody>{change.fields.map(field => <tr key={field.field}><td>{labels[field.field] ?? field.field}</td><td>{String(field.before ?? '—')}</td><td>{String(field.after ?? '—')}</td></tr>)}</tbody></table></div></details>)}
      <label className="field">CSV取込の理由<input value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></label><button className="button" disabled={busy || !reason.trim() || !preview.batchId} onClick={() => void confirm()}>内容を確認して取り込む</button><p className="muted form-note">プレビューは15分間有効です。確認後に他の操作で変更された場合は、再確認が必要です。</p>
    </>}</div>}
  </div></section>;
}
