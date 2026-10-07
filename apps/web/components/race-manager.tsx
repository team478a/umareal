'use client';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowRight, Eye, FileUp, Plus, RefreshCw } from 'lucide-react';
import { entryHeaders, entryStatuses, jstDate, parseQuickRaceList, raceHeaders, raceStatuses, serializeRaceCsv, venues, type EntryInput, type HorseIdentityHistoryResponse, type HorseIdentityReviewResponse, type ImportKind, type RaceAnnouncementNotificationPreviewResponse, type RaceDataStatus, type RaceExpertListResponse, type RaceInput, type RaceOperationHistoryResponse } from '@keiba/domain';
import { NotificationPreview } from './notification-preview';

type Entry = Omit<EntryInput, 'gate' | 'sex' | 'age' | 'carriedWeight' | 'jockey' | 'trainer' | 'winOdds'> & { id: string; gate: number | null; sex: EntryInput['sex'] | null; age: number | null; carriedWeight: string | number | null; jockey: string | null; trainer: string | null; winOdds: string | number | null };
type Race = Omit<RaceInput, 'expertId'> & { id: string; revision: number; entries?: Entry[]; announcements?: { id: string; version: number; publishedAt: string }[]; assignments: { userId: string; user?: { displayName: string } }[]; _count?: { entries: number } };
type Expert = { id: string; displayName: string };
type Day = { id: string; raceDate: string; venue: string; _count: { races: number } };
type Preview = { batchId: string | null; expiresAt?: string; errors: { row: number; field: string; message: string }[]; changes: { key: string; action: string; fields: { field: string; before: unknown; after: unknown }[] }[] };
type BundlePreview = Preview & { targetDate?: string; sourceChecksum: string; resultsIncluded?: boolean; raceCount?: number; entryCount?: number };
const labels: Record<string, string> = { raceDate: '開催日', venue: '競馬場', number: '番号', name: 'レース名', raceClass: 'クラス', distance: '距離（m）', surface: '馬場', direction: 'コース', startsAt: '発走日時（JST）', going: '馬場状態', weather: '天候', status: '状態', expertId: '予想担当', horseId: '馬ID', gate: '枠番', horseName: '馬名', sex: '性別', age: '年齢', carriedWeight: '斤量（kg）', jockey: '騎手', trainer: '調教師', winOdds: '単勝オッズ', popularity: '人気' };
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
async function loadExperts(search = ''): Promise<RaceExpertListResponse> {
  const query = new URLSearchParams({ limit: '50' });
  if (search.trim()) query.set('search', search.trim());
  return request<RaceExpertListResponse>(`race-experts?${query}`);
}
function Pager({ page, total, setPage, limit = 20 }: { page: number; total: number; setPage: (page: number) => void; limit?: number }) {
  return <div className="pagination"><span>全{total}件 · {page}ページ</span><button className="button secondary small" disabled={page === 1} onClick={() => setPage(page - 1)}>前へ</button><button className="button secondary small" disabled={page * limit >= total} onClick={() => setPage(page + 1)}>次へ</button></div>;
}
function Field({ name, label, value, type = 'text', required = true, options, step }: { name: string; label?: string; value?: string | number | null; type?: string; required?: boolean; options?: Record<string, string>; step?: string }) {
  const labelId = useId();
  return <label className="field"><span id={labelId}>{label ?? labels[name]}</span>{options ? <select aria-labelledby={labelId} name={name} defaultValue={value ?? ''} required={required}>{Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select> : <input aria-labelledby={labelId} name={name} defaultValue={value ?? ''} type={type} required={required} step={step} maxLength={type === 'text' ? 100 : undefined} />}</label>;
}

export function RaceManager({ canCorrectIdentity = false }: { canCorrectIdentity?: boolean }) {
  const [date, setDate] = useState(jstDate(new Date())); const [days, setDays] = useState<Day[]>([]); const [dayPage, setDayPage] = useState(1); const [dayTotal, setDayTotal] = useState(0);
  const [races, setRaces] = useState<Race[]>([]); const [experts, setExperts] = useState<Expert[]>([]); const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Race | null>(null); const [editing, setEditing] = useState(false); const [entry, setEntry] = useState<Entry | null>(null);
  const [dataStatus, setDataStatus] = useState<RaceDataStatus | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [announcementReasons, setAnnouncementReasons] = useState<Record<string, string>>({});
  const [announcementPreview, setAnnouncementPreview] = useState<RaceAnnouncementNotificationPreviewResponse | null>(null); const [previewBusy, setPreviewBusy] = useState('');
  const load = useCallback(async () => {
    try { const [r, d, source] = await Promise.all([request<{ items: Race[]; total: number }>(`races?date=${date}&page=${page}`), request<{ items: Day[]; total: number }>(`race-days?page=${dayPage}`), request<RaceDataStatus>('race-data-status')]); setRaces(r.items); setTotal(r.total); setDays(d.items); setDayTotal(d.total); setDataStatus(source); }
    catch (e) { setError((e as Error).message); }
  }, [date, page, dayPage]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { loadExperts().then(result => setExperts(result.items)).catch(e => setError((e as Error).message)); }, []);
  async function open(id: string) { setError(''); try { setSelected(await request<Race>(`races/${id}`)); setEntry(null); setEditing(true); } catch (e) { setError((e as Error).message); } }
  async function previewAnnouncement(race: Race) { setPreviewBusy(race.id); setError(''); setMessage(''); try { setAnnouncementPreview(await request<RaceAnnouncementNotificationPreviewResponse>(`notifications/previews/race-announcement?raceId=${race.id}`)); } catch (e) { setError((e as Error).message); } finally { setPreviewBusy(''); } }
  async function announce(race: Race) { const reason = announcementReasons[race.id]?.trim(); if (!reason) { setError('告知理由を入力してください。'); return; } setBusy(true); setError(''); setMessage(''); try { const result = await request<{ version: number }>(`races/${race.id}/announce`, 'POST', { reason }); setAnnouncementReasons({ ...announcementReasons, [race.id]: '' }); setAnnouncementPreview(null); setMessage(`${race.venue} ${race.number}Rを告知しました（第${result.version}版）。`); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function saveDay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try { const day = { raceDate: String(form.get('raceDate')), venue: String(form.get('venue')) }; await request('race-days', 'POST', { day, reason: form.get('reason') }); setDate(day.raceDate); setMessage('開催日を登録しました。'); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><span className="eyebrow">RACE OPERATIONS</span><h1>レース管理</h1><p>開催日・出走馬・担当者を登録し、CSVの差分を確認して取り込みます。</p></div>
    <ErrorMessage error={error} />{message && <div className="notice" role="status">{message}</div>}
    {dataStatus && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DATA SOURCE</span><h2>データ取得方式</h2></div><span className="status-tag">正常</span></div><div className="panel-body"><p><strong>{dataStatus.label}</strong></p><p className="muted form-note">{dataStatus.externalIntegration === 'NOT_USED' ? '外部データ連携は使用していません。レース・出走馬・結果を管理画面またはCSVから登録できます。' : '外部Providerのデータも、確認・プレビュー後にUMAREAL標準データへ取り込みます。'}</p></div></section>}
    <HorseIdentityReview date={date} races={races} refreshKey={selected?.revision ?? 0} />
    <HorseIdentityHistory canCorrect={canCorrectIdentity} />
    <QuickRaceRegistration initialDate={date} onConfirmed={async targetDate => { setDate(targetDate); setPage(1); setEditing(false); setSelected(null); if (targetDate === date) await load(); }} />
    <section className="panel"><div className="panel-heading"><h2>開催日</h2></div><form onSubmit={saveDay} className="panel-body"><div className="race-form-grid"><Field name="raceDate" type="date" value={date} /><Field name="venue" value="東京" options={Object.fromEntries(venues.map(v => [v, v]))} /><Field name="reason" label="開催日の登録理由" /><div className="field-action"><button className="button" disabled={busy}><Plus size={16} />開催日を登録</button></div></div></form>
      <div className="day-list">{days.map(day => <button key={day.id} className={`day-chip ${day.raceDate === date ? 'selected' : ''}`} onClick={() => { setDate(day.raceDate); setPage(1); setEditing(false); setSelected(null); }}>{day.raceDate} · {day.venue}<small>{day._count.races} レース</small></button>)}</div><Pager page={dayPage} total={dayTotal} setPage={setDayPage} />
    </section>
    <section className="panel"><div className="panel-heading race-toolbar"><h2>登録レース</h2><label className="date-filter">表示する開催日<input aria-label="表示する開催日" type="date" value={date} onChange={e => { setDate(e.target.value); setPage(1); setEditing(false); setSelected(null); }} /></label><button className="button" onClick={() => { setSelected(null); setEntry(null); setEditing(true); }}><Plus size={16} />レースを追加</button></div>
      {races.length > 0 && <div className="announcement-quick-list"><div className="quick-list-heading"><strong>対象レース告知</strong><small>対象人数と本文を確認してから公開します。</small></div>{races.map(race => <div className="announcement-quick-row" key={race.id}><div><strong>{race.venue} {race.number}R {race.name}</strong><small>{race.announcements?.[0] ? `告知済み・第${race.announcements[0].version}版` : '未告知'}</small></div><label className="field"><span className="sr-only">{race.name}の告知理由</span><input aria-label={`${race.name}の告知理由`} value={announcementReasons[race.id] ?? ''} maxLength={500} onChange={event => setAnnouncementReasons({ ...announcementReasons, [race.id]: event.target.value })} placeholder="対象レースとして決定" /></label><button className="button secondary small" disabled={busy || previewBusy === race.id || !(announcementReasons[race.id] ?? '').trim()} onClick={() => void previewAnnouncement(race)}><Eye size={16} />{previewBusy === race.id ? '確認中…' : '配信内容を確認'}</button>{announcementPreview?.race.id === race.id && <NotificationPreview preview={announcementPreview} busy={busy} action={{ label: race.announcements?.[0] ? 'この内容で再告知する' : 'この内容で告知する', onClick: () => void announce(race) }} />}</div>)}</div>}
      {races.length ? <div className="table-scroll"><table className="race-data-table"><thead><tr><th>レース</th><th>発走（JST）</th><th>状態</th><th>出走馬</th><th>予想担当</th><th>操作</th></tr></thead><tbody>{races.map(r => <tr key={r.id}><td>{r.venue} {r.number}R<br /><strong>{r.name}</strong></td><td>{new Date(r.startsAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}</td><td>{choices.status[r.status]}</td><td>{r._count?.entries ?? 0}頭</td><td>{r.assignments.map(a => a.user?.displayName ?? a.userId).join('、') || '未割当'}</td><td><button className="button secondary small" onClick={() => void open(r.id)}>編集・出走馬</button></td></tr>)}</tbody></table></div> : <div className="empty"><h3>この日のレースは未登録です</h3><p>レースを追加するか、CSVを取り込んでください。</p></div>}<Pager page={page} total={total} setPage={setPage} />
    </section>
    {editing && <RaceEditor key={selected ? `${selected.id}-${selected.revision}` : `new-${date}`} race={selected} date={date} experts={experts} onSaved={async r => { setSelected(r); setMessage('レース情報を保存しました。'); await load(); }} onReload={() => selected && void open(selected.id)} />}
    {selected && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">{selected.venue} {selected.number}R · {selected.name}</span><h2>出走馬</h2></div><button className="button secondary small" onClick={() => setEntry(null)}>新しい馬を入力</button></div>
      <QuickManualEntry race={selected} onSaved={async warning => { await open(selected.id); await load(); setMessage(warning || '出走馬を簡易登録しました。詳細情報は後から補完できます。'); }} />
      <div className="table-scroll"><table className="race-data-table"><thead><tr><th>馬番 / 枠</th><th>馬名</th><th>性齢 / 斤量</th><th>騎手</th><th>状態</th><th>操作</th></tr></thead><tbody>{selected.entries?.map(e => <tr key={e.id}><td>{e.number} / {e.gate ?? '未確認'}</td><td>{e.horseName}</td><td>{e.sex && e.age !== null ? `${choices.sex[e.sex]}${e.age}` : '未確認'} · {e.carriedWeight !== null ? `${e.carriedWeight}kg` : '未確認'}</td><td>{e.jockey ?? '未確認'}</td><td>{e.status === 'ACTIVE' ? '出走予定' : choices.status[e.status]}</td><td><button className="button secondary small" onClick={() => setEntry(e)}>編集</button></td></tr>)}</tbody></table></div>
      <EntryEditor key={`${selected.id}-${selected.revision}-${entry?.id ?? 'new'}`} race={selected} entry={entry} onSaved={async () => { await open(selected.id); await load(); setMessage('出走馬を保存しました。'); }} />
      <RaceOperationHistory raceId={selected.id} />
    </section>}
    <JraVanBundleImport manualMode={dataStatus?.mode === 'MANUAL'} onConfirmed={async targetDate => { setDate(targetDate); setPage(1); setEditing(false); setSelected(null); await load(); }} />
    <CsvImport key={selected?.id ?? 'races'} race={selected} onConfirmed={async () => { await load(); if (selected) await open(selected.id); }} />
  </>;
}

const operationLabels: Record<string, string> = {
  RACE_CREATE: 'レース作成', RACE_UPDATE: 'レース更新', ENTRY_SAVE: '出走馬保存', MANUAL_ENTRY_CREATE: '出走馬簡易登録',
  RACE_ANNOUNCE: '対象レース告知', ASSESSMENT_SAVE: 'パドック評価保存', PREDICTION_DRAFT_SAVE: '予想下書き保存',
  PREDICTION_PUBLISH: '予想公開', PREDICTION_CORRECT: '予想訂正版公開', RACE_RESULT_DRAFT_SAVE: '結果下書き保存',
  RACE_RESULT_CONFIRM: '結果確定', RACE_RESULT_CSV_IMPORT_CONFIRMED: '結果CSV取込', AI_GUIDE_GENERATION_REQUEST: 'AIガイド生成',
  AI_GUIDE_APPROVE: 'AIガイド承認', AI_GUIDE_PUBLISH: 'AIガイド公開', AI_GUIDE_CORRECTION_PUBLISH: 'AIガイド訂正版公開'
};

function RaceOperationHistory({ raceId }: { raceId: string }) {
  const [value, setValue] = useState<RaceOperationHistoryResponse | null>(null); const [page, setPage] = useState(1); const [error, setError] = useState('');
  useEffect(() => { setPage(1); }, [raceId]);
  useEffect(() => { request<RaceOperationHistoryResponse>(`races/${raceId}/history?page=${page}&limit=20`).then(setValue).catch(e => setError((e as Error).message)); }, [raceId, page]);
  return <div className="panel-body"><div className="panel-heading"><div><span className="eyebrow">AUDIT TRAIL</span><h3>このレースの操作履歴</h3></div></div><ErrorMessage error={error} />
    {value?.items.length ? <div className="table-scroll"><table className="race-data-table"><thead><tr><th>操作 / 取得方式</th><th>担当者</th><th>理由</th><th>日時（JST）</th></tr></thead><tbody>{value.items.map(item => <tr key={item.id}><td>{operationLabels[item.action] ?? item.action}<small>{item.sourceType} · {item.targetType}</small></td><td>{item.actorDisplayName ?? 'システム'}<small>{item.actorRole ?? 'SYSTEM'}</small></td><td>{item.reason}</td><td>{new Date(item.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td></tr>)}</tbody></table></div> : <p className="muted form-note">操作履歴はまだありません。</p>}
    {value && <Pager page={page} total={value.total} setPage={setPage} limit={value.limit} />}
  </div>;
}

function HorseIdentityReview({ date, races, refreshKey }: { date: string; races: Race[]; refreshKey: number }) {
  const [value, setValue] = useState<HorseIdentityReviewResponse | null>(null); const [page, setPage] = useState(1);
  const [reasons, setReasons] = useState<Record<string, string>>({}); const [targets, setTargets] = useState<Record<string, string>>({});
  const [commonReason, setCommonReason] = useState(''); const [raceId, setRaceId] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), limit: '20', date });
    if (raceId) query.set('raceId', raceId);
    try { setValue(await request<HorseIdentityReviewResponse>(`horse-identities/review?${query}`)); }
    catch (e) { setError((e as Error).message); }
  }, [date, page, raceId, refreshKey]);
  useEffect(() => { setPage(1); setRaceId(''); }, [date]);
  useEffect(() => { void load(); }, [load]);
  async function resolve(identity: HorseIdentityReviewResponse['items'][number], decision: 'MATCH_EXISTING' | 'CONFIRM_DISTINCT') {
    const reason = reasons[identity.id]?.trim() || commonReason.trim(); const resolvedHorseId = decision === 'CONFIRM_DISTINCT' ? identity.provisionalHorse.id : targets[identity.id] ?? identity.candidates[0]?.id;
    if (!reason) { setError('Identityの確認理由を入力してください。'); return; }
    if (!resolvedHorseId) { setError('紐付け先の既存馬を選択してください。'); return; }
    setBusy(identity.id); setError(''); setMessage('');
    try {
      await request(`horse-identities/${identity.id}/resolve`, 'POST', { decision, resolvedHorseId, reason });
      setReasons({ ...reasons, [identity.id]: '' });
      setMessage(decision === 'MATCH_EXISTING' ? `${identity.observedName}を既存馬へ紐付けました。` : `${identity.observedName}を別の馬として確定しました。`);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">HORSE IDENTITY</span><h2>暫定馬の確認</h2></div><span className="status-tag">未確認 {value?.total ?? 0}件</span></div><div className="panel-body">
    <p className="muted form-note">表示中の開催日に簡易登録した馬だけを確認します。既存馬へ紐付けるか別馬として確定しても、レース出走馬・公開済み予想・結果は書き換えません。</p>
    <ErrorMessage error={error} />{message && <div className="notice" role="status">{message}</div>}
    <div className="race-form-grid"><label className="field">対象レース<select aria-label="暫定馬を絞り込むレース" value={raceId} onChange={event => { setRaceId(event.target.value); setPage(1); }}><option value="">{date}の全レース</option>{races.map(race => <option key={race.id} value={race.id}>{race.venue} {race.number}R {race.name}</option>)}</select></label><label className="field">共通の確認理由<input aria-label="暫定馬の共通確認理由" value={commonReason} maxLength={500} onChange={event => setCommonReason(event.target.value)} placeholder="例：出馬表と同名候補を確認" /></label></div>
    <p className="muted form-note">共通理由は各馬の理由が空欄の場合に使用します。個別の事情がある馬だけ理由を上書きしてください。</p>
    {value?.items.length ? value.items.map(identity => <div className="identity-review-item" key={identity.id}><h3>{identity.observedName}</h3><p>{identity.races.map(race => `${race.venue} ${race.number}R ${race.entryNumber}番`).join('、')} · 使用レース {identity.provisionalHorse.entryCount}件</p>
      {identity.candidates.length > 0 ? <label className="field">同名の既存馬<select aria-label={`${identity.observedName}の紐付け先`} value={targets[identity.id] ?? identity.candidates[0].id} onChange={event => setTargets({ ...targets, [identity.id]: event.target.value })}>{identity.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} · 使用レース{candidate.entryCount}件 · {candidate.id}</option>)}</select></label> : <p className="muted form-note">同名の既存馬候補はありません。</p>}
      <label className="field">個別の確認理由（任意）<input aria-label={`${identity.observedName}のIdentity確認理由`} value={reasons[identity.id] ?? ''} maxLength={500} onChange={event => setReasons({ ...reasons, [identity.id]: event.target.value })} placeholder={commonReason || '共通理由または個別理由を入力'} /></label>
      <div className="button-row">{identity.candidates.length > 0 && <button className="button" disabled={busy === identity.id} onClick={() => void resolve(identity, 'MATCH_EXISTING')}>既存馬へ紐付け</button>}<button className="button secondary" disabled={busy === identity.id} onClick={() => void resolve(identity, 'CONFIRM_DISTINCT')}>別の馬として確定</button></div>
    </div>) : <div className="empty"><h3>確認待ちの暫定馬はありません</h3><p>簡易登録した馬はここで確認できます。</p></div>}
    {value && <Pager page={page} total={value.total} setPage={setPage} limit={value.limit} />}
  </div></section>;
}

function HorseIdentityHistory({ canCorrect }: { canCorrect: boolean }) {
  const [value, setValue] = useState<HorseIdentityHistoryResponse | null>(null); const [page, setPage] = useState(1);
  const [reasons, setReasons] = useState<Record<string, string>>({}); const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try { setValue(await request<HorseIdentityHistoryResponse>(`horse-identities/history?page=${page}&limit=20`)); }
    catch (e) { setError((e as Error).message); }
  }, [page]);
  useEffect(() => { void load(); }, [load]);
  async function correct(identity: HorseIdentityHistoryResponse['items'][number]) {
    const reason = reasons[identity.id]?.trim(); const resolvedHorseId = targets[identity.id] ?? identity.candidates[0]?.id;
    if (!reason) { setError('Identityの訂正理由を入力してください。'); return; }
    if (!resolvedHorseId) { setError('訂正先の同名馬を選択してください。'); return; }
    setBusy(identity.id); setError(''); setMessage('');
    try {
      await request(`horse-identities/${identity.id}/correct`, 'POST', { resolvedHorseId, expectedHorseId: identity.currentHorse.id, expectedUpdatedAt: identity.updatedAt, reason });
      setReasons({ ...reasons, [identity.id]: '' }); setMessage(`${identity.observedName}のIdentityを訂正し、以前の判断を履歴に残しました。`); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  return <details className="panel"><summary className="panel-heading"><div><span className="eyebrow">IDENTITY HISTORY</span><h2>確認済みIdentityと訂正</h2></div><span className="status-tag">確認済み {value?.total ?? 0}件</span></summary><div className="panel-body">
    <p className="muted form-note">確定済みの紐付けと判断履歴を確認できます。訂正しても、過去の出走馬・予想・結果・監査ログは書き換えません。</p><ErrorMessage error={error} />{message && <div className="notice" role="status">{message}</div>}
    {value?.items.length ? value.items.map(identity => <div className="identity-review-item" key={identity.id}><h3>{identity.observedName}</h3><p>現在の紐付け: <code>{identity.currentHorse.id}</code> · 使用レース {identity.currentHorse.entryCount}件</p>
      <ul>{identity.history.map(item => <li key={item.id}>{new Date(item.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} · {item.actorDisplayName ?? 'システム'}（{item.actorRole ?? 'SYSTEM'}）· {item.action === 'HORSE_IDENTITY_CORRECT' ? '訂正' : '初回確認'} · {item.reason}</li>)}</ul>
      {canCorrect && identity.candidates.length > 0 && <><label className="field">訂正先の同名馬<select aria-label={`${identity.observedName}のIdentity訂正先`} value={targets[identity.id] ?? identity.candidates[0].id} onChange={event => setTargets({ ...targets, [identity.id]: event.target.value })}>{identity.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} · 使用レース{candidate.entryCount}件 · {candidate.id}</option>)}</select></label><label className="field">訂正理由<input aria-label={`${identity.observedName}のIdentity訂正理由`} value={reasons[identity.id] ?? ''} maxLength={500} onChange={event => setReasons({ ...reasons, [identity.id]: event.target.value })} /></label><button className="button secondary" disabled={busy === identity.id} onClick={() => void correct(identity)}>履歴を残して訂正</button></>}
      {canCorrect && identity.candidates.length === 0 && <p className="muted form-note">訂正先にできる同名馬はありません。</p>}
    </div>) : <p className="muted form-note">確認済みIdentityはまだありません。</p>}
    {value && <Pager page={page} total={value.total} setPage={setPage} limit={value.limit} />}
  </div></details>;
}

function QuickManualEntry({ race, onSaved }: { race: Race; onSaved: (message?: string) => Promise<void> }) {
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = event.currentTarget; const data = new FormData(form);
    try {
      const result = await request<{ identity: { status: string; duplicateCandidateCount: number } }>(`races/${race.id}/entries/manual`, 'POST', { entry: { number: Number(data.get('number')), horseName: String(data.get('horseName')) }, revision: race.revision, reason });
      form.reset();
      await onSaved(result.identity.status === 'POSSIBLE_DUPLICATE' ? `出走馬を登録しました。同名馬が${result.identity.duplicateCandidateCount}頭いるため、正式IDとの統合は保留されています。` : undefined);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const nextNumber = Array.from({ length: 18 }, (_, i) => i + 1).find(number => !race.entries?.some(entry => entry.number === number));
  return <form className="panel-body entry-editor" onSubmit={save}><h3>馬番と馬名だけで簡易登録</h3><ErrorMessage error={error} /><div className="race-form-grid"><Field name="number" label="馬番" type="number" value={nextNumber} /><Field name="horseName" label="馬名" /><label className="field">簡易登録の理由<input aria-label="簡易登録の理由" value={reason} onChange={event => setReason(event.target.value)} required maxLength={500} /></label></div><p className="muted form-note">理由は次の馬にも引き継ぎます。枠番・性齢・斤量・騎手・調教師は未確認のまま保存し、馬名だけで既存馬と統合しません。</p><button className="button" disabled={busy || nextNumber === undefined || !reason.trim()}>{busy ? '登録中…' : '出走馬を簡易登録'}</button></form>;
}

function QuickRaceRegistration({ initialDate, onConfirmed }: { initialDate: string; onConfirmed: (targetDate: string) => Promise<void> }) {
  const [raceDate, setRaceDate] = useState(initialDate); const [raceClass, setRaceClass] = useState('未設定');
  const [source, setSource] = useState(''); const [preview, setPreview] = useState<Preview | null>(null); const [reason, setReason] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    const parsed = parseQuickRaceList({ raceDate, raceClass, text: source });
    if (parsed.errors.length) { setPreview({ batchId: null, errors: parsed.errors, changes: [] }); setBusy(false); return; }
    try { setPreview(await request<Preview>('races/import/preview', 'POST', { kind: 'races', csv: serializeRaceCsv(parsed.races) })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview?.batchId) return;
    setBusy(true); setError('');
    const count = preview.changes.length;
    try {
      await request(`races/import/${preview.batchId}/confirm`, 'POST', { reason });
      setPreview(null); setReason(''); setSource(''); setMessage(`${count}レースを登録しました。`); await onConfirmed(raceDate);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel quick-race-registration"><div className="panel-heading"><div><span className="eyebrow">QUICK REGISTRATION</span><h2>かんたん一括登録</h2></div><Plus size={22} /></div><div className="panel-body"><ErrorMessage error={error} />{message && <div className="notice" role="status">{message}</div>}
    <p>開催日とクラスを1回入力し、競馬場ごとのレース一覧を貼り付けます。登録前に追加・変更内容を確認できます。</p>
    <div className="race-form-grid"><label className="field">開催日<input aria-label="かんたん登録の開催日" type="date" value={raceDate} onChange={event => { setRaceDate(event.target.value); setPreview(null); }} /></label><label className="field">クラスの初期値<input aria-label="かんたん登録のクラス" value={raceClass} maxLength={60} onChange={event => { setRaceClass(event.target.value); setPreview(null); }} /></label></div>
    <label className="field">レース一覧<textarea aria-label="かんたん登録のレース一覧" rows={9} value={source} onChange={event => { setSource(event.target.value); setPreview(null); }} placeholder={'東京\n9R 八ヶ岳特別 14:35 芝1800 左\n10R 白秋ステークス 15:10 芝1400 左\n\n京都\n10R 大山崎ステークス 15:00 ダート1200 右'} /></label>
    <p className="muted form-note">1行目に競馬場名、続けて「9R レース名 14:35 芝1800 左」の順で入力します。ダートは「ダ」でも入力できます。馬場状態・天候は未確認、状態は開催予定、予想担当は未割当で登録します。クラスが異なるレースは登録後に編集してください。</p>
    <button className="button secondary" disabled={busy || !source.trim() || !raceDate || !raceClass.trim()} onClick={() => void check()}>{busy ? '確認中…' : '内容を確認'}</button>
    {preview && <div className="import-preview"><h3>登録前の確認</h3>{preview.errors.length ? <div role="alert"><ul>{preview.errors.map((issue, index) => <li key={index}>{issue.row ? `${issue.row}行目 · ` : ''}{labels[issue.field] ?? issue.field}：{issue.message}</li>)}</ul></div> : <>
      <p className="muted form-note">追加 {preview.changes.filter(change => change.action === '追加').length}件 ／ 変更 {preview.changes.filter(change => change.action === '変更').length}件 ／ 変更なし {preview.changes.filter(change => change.action === '変更なし').length}件</p>
      {preview.changes.map((change, index) => <details key={index} open={change.action === '変更'}><summary><span className="status-tag">{change.action}</span> {change.key}</summary>{change.fields.length > 0 && <div className="table-scroll"><table className="race-data-table"><thead><tr><th>項目</th><th>現在</th><th>登録後</th></tr></thead><tbody>{change.fields.map(field => <tr key={field.field}><td>{labels[field.field] ?? field.field}</td><td>{String(field.before ?? '—')}</td><td>{String(field.after ?? '—')}</td></tr>)}</tbody></table></div>}</details>)}
      <label className="field">一括登録の理由<input aria-label="かんたん一括登録の理由" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} /></label><button className="button" disabled={busy || !reason.trim() || !preview.batchId} onClick={() => void confirm()}>{busy ? '登録中…' : '確認した内容を登録'}</button><p className="muted form-note">確認内容は15分間有効です。確定時にも重複や変更を再検証します。</p>
    </>}</div>}
  </div></section>;
}

function RaceEditor({ race, date, experts, onSaved, onReload }: { race: Race | null; date: string; experts: Expert[]; onSaved: (race: Race) => Promise<void>; onReload: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const currentExpert = race?.assignments[0] ? { id: race.assignments[0].userId, displayName: race.assignments[0].user?.displayName ?? '現在の担当者' } : null;
  const mergeExperts = (items: Expert[]) => currentExpert && !items.some(item => item.id === currentExpert.id) ? [currentExpert, ...items] : items;
  const [expertOptions, setExpertOptions] = useState<Expert[]>(() => mergeExperts(experts));
  const [expertSearch, setExpertSearch] = useState(''); const [expertTotal, setExpertTotal] = useState<number | null>(null); const [expertBusy, setExpertBusy] = useState(false);
  async function searchExperts() {
    setExpertBusy(true); setError('');
    try { const result = await loadExperts(expertSearch); setExpertOptions(mergeExperts(result.items)); setExpertTotal(result.total); }
    catch (e) { setError((e as Error).message); } finally { setExpertBusy(false); }
  }
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
    <div className="field"><span>予想担当を検索</span><div className="field-search-row"><input aria-label="予想担当者名" value={expertSearch} maxLength={80} onChange={event => setExpertSearch(event.target.value)} placeholder="担当者名" /><button className="button secondary small" type="button" disabled={expertBusy} onClick={() => void searchExperts()}>{expertBusy ? '検索中…' : '検索'}</button></div>{expertTotal !== null && <small>{expertTotal}件見つかりました</small>}</div>
    <label className="field">予想担当<select aria-label="予想担当" name="expertId" defaultValue={race?.assignments[0]?.userId ?? ''}><option value="">未割当</option>{expertOptions.map(expert => <option key={expert.id} value={expert.id}>{expert.displayName}</option>)}</select></label><Field name="reason" label="レースの登録・変更理由" />
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
    <Field name="number" label="馬番" type="number" value={entry?.number ?? Array.from({ length: 18 }, (_, i) => i + 1).find(n => !race.entries?.some(e => e.number === n))} /><Field name="gate" type="number" value={entry ? entry.gate ?? '' : 1} /><Field name="horseName" value={entry?.horseName} />
    <Field name="horseId" value={horseId} /><Field name="sex" value={entry ? entry.sex ?? '' : 'MALE'} options={{ '': '未確認（選択必須）', ...choices.sex }} /><Field name="age" type="number" value={entry ? entry.age ?? '' : 3} />
    <Field name="carriedWeight" type="number" step="0.1" value={entry ? entry.carriedWeight ?? '' : 57} /><Field name="jockey" value={entry?.jockey ?? ''} /><Field name="trainer" value={entry?.trainer ?? ''} />
    <Field name="winOdds" type="number" step="0.1" required={false} value={entry?.winOdds} /><Field name="popularity" type="number" required={false} value={entry?.popularity} /><Field name="status" value={entry?.status ?? 'ACTIVE'} options={Object.fromEntries(entryStatuses.map(s => [s, s === 'ACTIVE' ? '出走予定' : choices.status[s]]))} />
    <Field name="reason" label="出走馬の登録・変更理由" />
  </div><p className="muted form-note">既存の馬は同じ馬IDを使ってください。登録済みの馬は一覧の「編集」から変更します。取消・除外は状態を変更して記録します。</p><button className="button" disabled={busy}>{busy ? '保存中…' : '出走馬を保存'}</button></form>;
}

async function readUtf8(file: File, maximum: number, label: string) {
  if (file.size > maximum) throw new Error(`${label}は${Math.floor(maximum / 1024)}KB以内にしてください。`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error(`${label}はUTF-8形式にしてください。`); }
}

function JraVanBundleImport({ manualMode, onConfirmed }: { manualMode: boolean; onConfirmed: (targetDate: string) => Promise<void> }) {
  const [manifest, setManifest] = useState(''); const [racesCsv, setRacesCsv] = useState('');
  const [entries, setEntries] = useState<{ path: string; csv: string }[]>([]); const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function manifestChanged(file?: File) { setPreview(null); setError(''); if (!file) { setManifest(''); return; } try { if (file.name !== 'manifest.json') throw new Error('manifest.jsonを選択してください。'); setManifest(await readUtf8(file, 30000, 'manifest.json')); } catch (e) { setError((e as Error).message); } }
  async function racesChanged(file?: File) { setPreview(null); setError(''); if (!file) { setRacesCsv(''); return; } try { if (file.name !== 'races.csv') throw new Error('races.csvを選択してください。'); setRacesCsv(await readUtf8(file, 65536, 'races.csv')); } catch (e) { setError((e as Error).message); } }
  async function entriesChanged(files?: FileList | null) {
    setPreview(null); setError(''); if (!files?.length) { setEntries([]); return; }
    try {
      const selected = await Promise.all([...files].map(async file => {
        const relative = file.webkitRelativePath.replace(/\\/g, '/'); const marker = relative.indexOf('/entries/');
        const path = marker >= 0 ? relative.slice(marker + 1) : `entries/${file.name}`;
        return { path, csv: await readUtf8(file, 65536, file.name) };
      }));
      if (new Set(selected.map(file => file.path)).size !== selected.length) throw new Error('同じ名前の出走馬CSVが重複しています。');
      setEntries(selected.sort((a, b) => a.path.localeCompare(b.path)));
    } catch (e) { setEntries([]); setError((e as Error).message); }
  }
  async function check() {
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try {
      const total = manifest.length + racesCsv.length + entries.reduce((sum, file) => sum + file.path.length + file.csv.length, 0);
      if (total > 90000) throw new Error('一括取込データは合計90,000文字以内にしてください。');
      setPreview(await request<BundlePreview>('races/import/bundle/preview', 'POST', { manifest, racesCsv, entries }));
    }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview?.batchId) return; setBusy(true); setError('');
    try {
      const result = await request<{ targetDate: string; raceCount: number; entryCount: number; resultsIncluded: boolean }>(`races/import/bundle/${preview.batchId}/confirm`, 'POST', { reason });
      setPreview(null); setReason(''); setMessage(`${result.targetDate}の${result.raceCount}レース・${result.entryCount}頭を取り込みました。${result.resultsIncluded ? '結果CSVは結果管理で別途確認してください。' : ''}`); await onConfirmed(result.targetDate);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const ready = manifest.trim() && racesCsv.trim() && entries.length;
  const keepOpen = !manualMode || !!manifest || !!racesCsv || entries.length > 0 || !!preview || !!message || !!error;
  return <details className="panel" open={keepOpen}><summary className="panel-heading"><div><span className="eyebrow">OPTIONAL DATA PROVIDER</span><h2>外部Providerの開催日一括取込</h2></div><FileUp size={22} /></summary><div className="panel-body"><ErrorMessage error={error} />{message && <div className="notice" role="status">{message}</div>}
    <div className="race-form-grid"><label className="field">manifest.json<input aria-label="JRA-VAN manifest" type="file" accept=".json,application/json" onChange={event => void manifestChanged(event.target.files?.[0])} /></label><label className="field">races.csv<input aria-label="JRA-VANレースCSV" type="file" accept=".csv,text/csv" onChange={event => void racesChanged(event.target.files?.[0])} /></label><label className="field">entriesフォルダー内の全CSV<input aria-label="JRA-VAN出走馬CSV" type="file" multiple accept=".csv,text/csv" onChange={event => void entriesChanged(event.target.files)} /><small>{entries.length ? `${entries.length}ファイル選択済み` : '対象日の全ファイルをまとめて選択'}</small></label></div>
    <p className="muted form-note">Windowsブリッジが生成したmanifest、races.csv、entries内の全CSVを選択します。SHA-256と対象レースの対応をサーバーで検証し、確認後に全体を一括反映します。results.csvは結果管理で別途照合します。</p>
    <button className="button secondary" disabled={busy || !ready} onClick={() => void check()}>{busy ? '確認中…' : '一括差分を確認'}</button>
    {preview && <div className="import-preview"><h3>一括取込前の確認</h3>{preview.errors.length ? <div role="alert"><ul>{preview.errors.map((issue, index) => <li key={index}>{issue.row ? `${issue.row}行目 · ` : ''}{issue.field}：{issue.message}</li>)}</ul></div> : <><p className="muted form-note">対象日 {preview.targetDate} · {preview.raceCount}レース · {preview.entryCount}頭 · ファイル指紋 {preview.sourceChecksum.slice(0, 12)}…</p>{preview.resultsIncluded && <div className="notice">確定結果ファイルが含まれています。この画面では反映せず、レース・出走馬の取込後に結果管理で照合します。</div>}<p className="muted form-note">追加 {preview.changes.filter(change => change.action === '追加').length}件 ／ 変更 {preview.changes.filter(change => change.action === '変更').length}件 ／ 変更なし {preview.changes.filter(change => change.action === '変更なし').length}件</p>{preview.changes.map((change, index) => <details key={index} open={change.action === '変更'}><summary><span className="status-tag">{change.action}</span> {change.key}</summary>{change.fields.length > 0 && <div className="table-scroll"><table className="race-data-table"><thead><tr><th>項目</th><th>現在</th><th>取込後</th></tr></thead><tbody>{change.fields.map(field => <tr key={field.field}><td>{labels[field.field] ?? field.field}</td><td>{String(field.before ?? '—')}</td><td>{String(field.after ?? '—')}</td></tr>)}</tbody></table></div>}</details>)}<label className="field">一括取込の理由<input aria-label="開催日一括取込の理由" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} /></label><button className="button" disabled={busy || !reason.trim() || !preview.batchId} onClick={() => void confirm()}>確認した開催日データを取り込む</button><p className="muted form-note">プレビューは15分間有効です。レースまたは出走馬が変更された場合は全体を再確認します。</p></>}</div>}
  </div></details>;
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
    <label className="field">CSVの内容<textarea aria-label="CSVの内容" rows={6} value={csv} onChange={e => { setCsv(e.target.value); setPreview(null); }} placeholder={(kind === 'races' ? raceHeaders : entryHeaders).join(',')} /></label><p className="muted form-note">UTF-8・200行以内。CSVにないレースや出走馬は削除しません。空の予想担当は未割当への変更として扱います。</p>
    <button className="button secondary" disabled={busy || !csv.trim()} onClick={() => void check()}>{busy ? '確認中…' : '差分を確認'}</button>
    {preview && <div className="import-preview"><h3>取込前の確認</h3>{preview.errors.length ? <div role="alert"><ul>{preview.errors.map((e, i) => <li key={i}>{e.row}行目 · {labels[e.field] ?? e.field}：{e.message}</li>)}</ul></div> : <>
      <p className="muted form-note">追加 {preview.changes.filter(c => c.action === '追加').length}件 ／ 変更 {preview.changes.filter(c => c.action === '変更').length}件 ／ 変更なし {preview.changes.filter(c => c.action === '変更なし').length}件</p>
      {preview.changes.map((change, i) => <details key={i} open={change.action === '変更'}><summary><span className="status-tag">{change.action}</span> {change.key}</summary><div className="table-scroll"><table className="race-data-table"><thead><tr><th>項目</th><th>現在</th><th>取込後</th></tr></thead><tbody>{change.fields.map(field => <tr key={field.field}><td>{labels[field.field] ?? field.field}</td><td>{String(field.before ?? '—')}</td><td>{String(field.after ?? '—')}</td></tr>)}</tbody></table></div></details>)}
      <label className="field">CSV取込の理由<input value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></label><button className="button" disabled={busy || !reason.trim() || !preview.batchId} onClick={() => void confirm()}>内容を確認して取り込む</button><p className="muted form-note">プレビューは15分間有効です。確認後に他の操作で変更された場合は、再確認が必要です。</p>
    </>}</div>}
  </div></section>;
}
