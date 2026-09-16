'use client';
import { useEffect, useState } from 'react';
import { Check, ChevronRight, FileUp } from 'lucide-react';

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> { const response = await fetch(`/api/v1/${path}`, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const value = await response.json(); if (!response.ok) throw new Error(value.message ?? '処理できませんでした。'); return value; }
type ResultProviderId = 'CANONICAL_CSV' | 'JRA_VAN_BRIDGE_V1';
type ResultProvider = { id: ResultProviderId; label: string; formatVersion: string; headers: string[] };
type RaceRow = { id: string; raceDate: string; venue: string; number: number; name: string; startsAt: string; status: string; draftRevision: number; draftSource: 'CSV_SINGLE' | 'CSV_BATCH' | null; draftProvider: ResultProviderId | null; latestResult: { version: number; sourceRevision: number; confirmedAt: string; raceCanceled: boolean } | null };
type DraftEntry = { entryId: string; status: 'FINISHED' | 'WITHDRAWN' | 'EXCLUDED' | 'DNF' | 'CANCELED'; finishPosition: number | null; popularity: number | null; finalOdds: string | null };
type Detail = { race: RaceRow; entries: { id: string; number: number; horseName: string }[]; draft: { revision: number; raceCanceled: boolean; reason: string; entries: DraftEntry[] }; versions: { id: string; version: number; sourceRevision: number; ruleVersion: string; raceCanceled: boolean; reason: string; confirmedAt: string }[] };
type ImportPreview = { batchId: string | null; expiresAt?: string; errors: { row: number; field: string; message: string }[]; changes: { key: string; action: '変更' | '変更なし'; fields: { field: string; before: unknown; after: unknown }[] }[] };
type ResultBundleProvenance = { formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1'; targetDate: string; manifestChecksum: string };
type BatchImportPreview = { provider: Omit<ResultProvider, 'headers'>; sourceChecksum: string; bundle?: ResultBundleProvenance | null; sourceDisposition?: 'NEW' | 'CORRECTION'; previousImport?: { batchId: string; confirmedAt: string; sourceChecksum: string } | null; duplicateOf?: { batchId: string; confirmedAt: string }; batchId: string | null; expiresAt?: string; errors: { row: number; field: string; message: string }[]; races: { raceId: string; key: string; targetRevision: number; changes: ImportPreview['changes'] }[] };
type ResultImportHistory = { batchId: string; provider: Omit<ResultProvider, 'headers'>; sourceChecksum: string; bundle: ResultBundleProvenance | null; sourceDisposition: 'NEW' | 'CORRECTION'; previousImportBatchId: string | null; actorDisplayName: string; confirmedAt: string; races: { raceId: string; label: string; revision: number }[] };
const resultFieldLabels: Record<string, string> = { raceCanceled: 'レース中止', status: '状態', finishPosition: '着順', popularity: '人気', finalOdds: '確定単勝', number: '馬番', horseNumber: '馬番', raceNumber: 'レース番号', raceDate: '開催日', venue: '競馬場', venueCode: '競馬場コード', abnormalCode: '異常区分コード', recordType: 'レコード種別', csv: 'CSV', header: '見出し' };
const resultProviderLabels: Record<ResultProviderId, string> = { CANONICAL_CSV: '内部標準CSV', JRA_VAN_BRIDGE_V1: 'JRA-VAN連携ブリッジ' };

export function AdminResults() {
  const [races, setRaces] = useState<RaceRow[]>([]), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  async function loadList() { try { setRaces((await api<{ items: RaceRow[] }>('admin/results/races')).items); } catch (e) { setError((e as Error).message); } }
  async function load(id: string) { setSelected(id); setError(''); try { setDetail(await api<Detail>(`admin/results/races/${id}`)); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void loadList(); }, []);
  function entry(id: string, patch: Partial<DraftEntry>) { if (!detail) return; setDetail({ ...detail, draft: { ...detail.draft, entries: detail.draft.entries.map(item => item.entryId === id ? { ...item, ...patch } : item) } }); }
  async function save() { if (!detail) return; setBusy(true); setError(''); setMessage(''); try { const value = await api<{ revision: number }>(`admin/results/races/${detail.race.id}`, 'PATCH', detail.draft); await load(detail.race.id); setMessage(`結果下書き版${value.revision}を保存しました。`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function confirm() { if (!detail) return; setBusy(true); setError(''); setMessage(''); try { const saved = await api<{ revision: number }>(`admin/results/races/${detail.race.id}`, 'PATCH', detail.draft); const value = await api<{ version: number }>(`admin/results/races/${detail.race.id}/confirm`, 'POST', { revision: saved.revision, reason: detail.draft.reason }); await load(detail.race.id); await loadList(); setMessage(`確定結果版${value.version}と公開版別の馬評価結果を保存しました。`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  if (!selected || !detail) return <><div className="page-heading"><span className="eyebrow">RESULT OPERATIONS</span><h1>結果・評価管理</h1><p>発走後の着順を確認し、公開版ごとの馬評価結果を確定します。</p></div>{error && <div className="notice error" role="alert">{error}</div>}<BatchResultCsvImport onImported={loadList} /><section className="panel"><div className="panel-heading"><h2>レース別の確認・確定</h2></div>{races.length ? races.map(race => { const pending = race.draftRevision > (race.latestResult?.sourceRevision ?? 0); const provider = race.draftProvider ? resultProviderLabels[race.draftProvider] : null; const state = pending && race.draftSource ? `CSV取込済み${provider ? `（${provider}）` : ''}・確認待ち（下書き版${race.draftRevision}）` : pending ? `確認待ち（下書き版${race.draftRevision}）` : race.latestResult ? `確定版${race.latestResult.version}` : '未入力'; return <button className="action-row" key={race.id} onClick={() => void load(race.id)}><div><strong>{race.venue} {race.number}R {race.name}</strong><small>{race.raceDate} · {state}</small></div><ChevronRight /></button>; }) : <div className="panel-body">結果入力の対象レースはありません。</div>}</section></>;
  return <><button className="button secondary" onClick={() => { setSelected(null); setDetail(null); }}>一覧へ戻る</button><div className="page-heading"><span className="eyebrow">RESULT REVIEW</span><h1>{detail.race.name}</h1><p>{detail.race.venue} {detail.race.number}R · 確定結果は上書きせず、新しい版として保存します。</p></div>{error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}<ResultCsvImport detail={detail} onImported={async revision => { await load(detail.race.id); await loadList(); setMessage(`CSVを結果下書き版${revision}へ反映しました。内容を確認してから結果を確定してください。`); }} /><section className="panel"><div className="panel-heading"><h2>着順・状態</h2><span className="status-tag">下書き版 {detail.draft.revision || '未保存'}</span></div><div className="panel-body"><label className="setting-row"><span><strong>レース中止</strong><small>中止時は全馬を中止として評価対象外にします。</small></span><input type="checkbox" checked={detail.draft.raceCanceled} onChange={e => setDetail({ ...detail, draft: { ...detail.draft, raceCanceled: e.target.checked, entries: detail.draft.entries.map(item => ({ ...item, status: e.target.checked ? 'CANCELED' : 'FINISHED', finishPosition: null })) } })} /></label><div className="table-scroll"><table><thead><tr><th>馬</th><th>状態</th><th>着順</th><th>人気</th><th>確定単勝</th></tr></thead><tbody>{detail.entries.map(horse => { const value = detail.draft.entries.find(item => item.entryId === horse.id)!; return <tr key={horse.id}><td>{horse.number}番 {horse.horseName}</td><td><select aria-label={`${horse.number}番の結果状態`} value={value.status} onChange={e => entry(horse.id, { status: e.target.value as DraftEntry['status'], finishPosition: e.target.value === 'FINISHED' ? value.finishPosition : null })}><option value="FINISHED">完走</option><option value="WITHDRAWN">取消</option><option value="EXCLUDED">除外</option><option value="DNF">競走中止</option><option value="CANCELED">レース中止</option></select></td><td><input aria-label={`${horse.number}番の着順`} type="number" min="1" max="18" disabled={value.status !== 'FINISHED'} value={value.finishPosition ?? ''} onChange={e => entry(horse.id, { finishPosition: e.target.value ? Number(e.target.value) : null })} /></td><td><input aria-label={`${horse.number}番の人気`} type="number" min="1" max="18" value={value.popularity ?? ''} onChange={e => entry(horse.id, { popularity: e.target.value ? Number(e.target.value) : null })} /></td><td><input aria-label={`${horse.number}番の確定単勝`} inputMode="decimal" value={value.finalOdds ?? ''} onChange={e => entry(horse.id, { finalOdds: e.target.value || null })} /></td></tr>; })}</tbody></table></div><label className="field">確認・訂正理由<input aria-label="結果の確認理由" maxLength={500} value={detail.draft.reason} onChange={e => setDetail({ ...detail, draft: { ...detail.draft, reason: e.target.value } })} /></label></div><div className="panel-actions"><button className="button secondary" disabled={busy || !detail.draft.reason.trim()} onClick={() => void save()}>下書きを保存</button><button className="button" disabled={busy || !detail.draft.reason.trim()} onClick={() => void confirm()}><Check size={17} />結果を確定</button></div></section>{detail.versions.length > 0 && <section className="panel"><div className="panel-heading"><h2>確定履歴</h2></div><div className="panel-body">{detail.versions.map(version => <p key={version.id}>版{version.version} · {new Date(version.confirmedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST · {version.reason}</p>)}</div></section>}</>;
}

function BatchResultCsvImport({ onImported }: { onImported: () => Promise<void> }) {
  const [csv, setCsv] = useState(''), [reason, setReason] = useState(''), [preview, setPreview] = useState<BatchImportPreview | null>(null);
  const [bundleManifest, setBundleManifest] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ResultProvider[]>([]), [providerId, setProviderId] = useState<ResultProviderId>('CANONICAL_CSV');
  const [history, setHistory] = useState<ResultImportHistory[]>([]);
  async function loadHistory() { setHistory((await api<{ items: ResultImportHistory[] }>('admin/results/import/history')).items); }
  useEffect(() => { api<{ items: ResultProvider[] }>('admin/results/import/providers').then(value => setProviders(value.items)).catch(e => setError(e.message)); loadHistory().catch(e => setError(e.message)); }, []);
  const provider = providers.find(item => item.id === providerId);
  async function fileChanged(file?: File) {
    setPreview(null); setError(''); setMessage(''); if (!file) return;
    if (file.size > 65536) { setError('CSVは64KB以内にしてください。'); return; }
    try { setCsv(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
    catch { setError('UTF-8形式のCSVを選択してください。'); }
  }
  async function manifestChanged(file?: File) {
    setPreview(null); setError(''); setMessage(''); if (!file) { setBundleManifest(''); return; }
    if (file.name !== 'manifest.json') { setError('JRA-VAN一括出力のmanifest.jsonを選択してください。'); return; }
    if (file.size > 30000) { setError('manifest.jsonは30KB以内にしてください。'); return; }
    try { setBundleManifest(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
    catch { setError('UTF-8形式のmanifest.jsonを選択してください。'); }
  }
  async function check() {
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try { setPreview(await api<BatchImportPreview>('admin/results/import/preview', 'POST', { csv, providerId, ...(bundleManifest ? { bundleManifest } : {}) })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function confirmImport() {
    if (!preview?.batchId) return; setBusy(true); setError(''); setMessage('');
    try {
      const value = await api<{ count: number }>(`admin/results/import/${preview.batchId}/confirm`, 'POST', { reason });
      setPreview(null); setCsv(''); setBundleManifest(''); setReason(''); setMessage(`${value.count}レースの結果下書きを反映しました。レース別に内容を確認して確定してください。`); await Promise.all([onImported(), loadHistory()]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-heading"><div><span className="eyebrow">BATCH RESULT CSV</span><h2>複数レース結果CSV</h2></div><FileUp size={22} /></div>
    <div className="panel-body">
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      <div className="race-form-grid">
        <label className="field">取込元<select aria-label="結果CSVの取込元" value={providerId} onChange={e => { setProviderId(e.target.value as ResultProviderId); setCsv(''); setBundleManifest(''); setPreview(null); setError(''); setMessage(''); }}>{providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="field">CSVファイル<input aria-label="複数レース結果CSVファイル" type="file" accept=".csv,text/csv" onChange={e => void fileChanged(e.target.files?.[0])} /></label>
        {providerId === 'JRA_VAN_BRIDGE_V1' && <label className="field">一括出力manifest<input aria-label="JRA-VAN結果manifest" type="file" accept=".json,application/json" onChange={e => void manifestChanged(e.target.files?.[0])} /></label>}
        <a className="text-link" href={providerId === 'JRA_VAN_BRIDGE_V1' ? '/samples/jra-van-bridge-results.csv' : '/samples/batch-results.csv'} download>{providerId === 'JRA_VAN_BRIDGE_V1' ? 'JRA-VANブリッジ用サンプルCSV' : '内部標準サンプルCSV'}</a>
      </div>
      <label className="field">CSVの内容<textarea aria-label="複数レース結果CSVの内容" rows={7} value={csv} onChange={e => { setCsv(e.target.value); setPreview(null); }} placeholder={provider?.headers.join(',') ?? '取込元を読み込み中です'} /></label>
      <p className="muted form-note">{providerId === 'JRA_VAN_BRIDGE_V1' ? 'Windows側の連携ブリッジが出力したresults.csvを指定します。同じ一括出力のmanifest.jsonも選ぶと、対象日・行数・レース数・SHA-256を検証します。' : 'ウマリアルの内部標準形式です。'} 各レースの全登録馬を指定し、1件でもエラーや競合がある場合はすべての反映を中止します。</p>
      <button className="button secondary" disabled={busy || !csv.trim()} onClick={() => void check()}>{busy ? '確認中…' : '複数レースの差分を確認'}</button>
      {preview && <div className="import-preview">
        <h3>一括反映前の確認</h3>
        <p className="muted form-note">取込元：{preview.provider.label}（{preview.provider.formatVersion}） · ファイル指紋：{preview.sourceChecksum.slice(0, 12)}…</p>
        {preview.bundle && <div className="notice">JRA-VAN一括出力を検証済み · 対象日 {preview.bundle.targetDate} · manifest指紋 {preview.bundle.manifestChecksum.slice(0, 12)}…</div>}
        {preview.sourceDisposition === 'CORRECTION' && preview.previousImport && <div className="notice">同じ対象レースの以前の取込があります。公式訂正として新しい下書き版を作成します。前回：{new Date(preview.previousImport.confirmedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</div>}
        {preview.errors.length ? <div role="alert"><ul>{preview.errors.map((issue, index) => <li key={index}>{issue.row ? `${issue.row}行目 · ` : ''}{resultFieldLabels[issue.field] ?? issue.field}：{issue.message}</li>)}</ul></div> : <>
          <p className="muted form-note">対象 {preview.races.length}レース。反映後も結果は未確定です。</p>
          {preview.races.map(race => <details key={race.raceId} open><summary><span className="status-tag">下書き版{race.targetRevision}</span> {race.key}</summary>{race.changes.filter(change => change.action === '変更').map(change => <div key={change.key}><strong>{change.key}</strong><ul>{change.fields.map(field => <li key={field.field}>{resultFieldLabels[field.field] ?? field.field}：{String(field.before ?? '—')} → {String(field.after ?? '—')}</li>)}</ul></div>)}</details>)}
          <label className="field">一括CSV取込の理由<input aria-label="複数レースCSV取込の理由" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <button className="button" disabled={busy || !reason.trim() || !preview.batchId} onClick={() => void confirmImport()}>確認した全レースを下書きへ反映</button>
          <p className="muted form-note">プレビューは15分間有効です。取込元とファイル指紋を監査へ保存します。結果確定と会員通知はレース別の確認後に実行されます。</p>
        </>}
      </div>}
      <div className="import-preview" aria-label="結果CSV取込履歴">
        <h3>最近の取込履歴</h3>
        {history.length ? history.map(item => <details key={item.batchId}><summary><span className="status-tag">{item.sourceDisposition === 'CORRECTION' ? '公式訂正' : '初回取込'}</span> {item.provider.label} · {new Date(item.confirmedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</summary><p className="muted form-note">担当：{item.actorDisplayName} · ファイル指紋：{item.sourceChecksum.slice(0, 12)}…{item.bundle ? ` · bundle対象日：${item.bundle.targetDate}` : ''}</p><ul>{item.races.map(race => <li key={race.raceId}>{race.label} · 下書き版{race.revision}</li>)}</ul></details>) : <p className="muted form-note">確定済みの一括取込はありません。</p>}
      </div>
    </div>
  </section>;
}

function ResultCsvImport({ detail, onImported }: { detail: Detail; onImported: (revision: number) => Promise<void> }) {
  const [csv, setCsv] = useState(''), [raceCanceled, setRaceCanceled] = useState(detail.draft.raceCanceled), [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function fileChanged(file?: File) {
    setPreview(null); setError(''); if (!file) return;
    if (file.size > 65536) { setError('CSVは64KB以内にしてください。'); return; }
    try { setCsv(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); }
    catch { setError('UTF-8形式のCSVを選択してください。'); }
  }
  async function check() {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await api<ImportPreview>(`admin/results/races/${detail.race.id}/import/preview`, 'POST', { csv, raceCanceled })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function confirmImport() {
    if (!preview?.batchId) return; setBusy(true); setError('');
    try {
      const value = await api<{ revision: number }>(`admin/results/races/${detail.race.id}/import/${preview.batchId}/confirm`, 'POST', { reason });
      setPreview(null); setCsv(''); setReason(''); await onImported(value.revision);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">RESULT CSV</span><h2>公式結果CSV取込</h2></div><FileUp size={22} /></div><div className="panel-body">{error && <div className="notice error" role="alert">{error}</div>}<div className="race-form-grid"><label className="field">CSVファイル<input aria-label="結果CSVファイル" type="file" accept=".csv,text/csv" onChange={e => void fileChanged(e.target.files?.[0])} /></label><label className="setting-row"><span><strong>レース中止として取り込む</strong><small>有効時はCSVの全馬をCANCELEDにしてください。</small></span><input aria-label="CSVのレース中止" type="checkbox" checked={raceCanceled} onChange={e => { setRaceCanceled(e.target.checked); setPreview(null); }} /></label><a className="text-link" href="/samples/results.csv" download>サンプルCSVをダウンロード</a></div><label className="field">CSVの内容<textarea aria-label="結果CSVの内容" rows={6} value={csv} onChange={e => { setCsv(e.target.value); setPreview(null); }} placeholder="number,status,finishPosition,popularity,finalOdds" /></label><p className="muted form-note">選択中のレースに登録された全馬を1回ずつ指定してください。払戻、券種、買い目、購入金額は取り込みません。</p><button className="button secondary" disabled={busy || !csv.trim()} onClick={() => void check()}>{busy ? '確認中…' : '結果差分を確認'}</button>{preview && <div className="import-preview"><h3>下書き反映前の確認</h3>{preview.errors.length ? <div role="alert"><ul>{preview.errors.map((issue, index) => <li key={index}>{issue.row ? `${issue.row}行目 · ` : ''}{resultFieldLabels[issue.field] ?? issue.field}：{issue.message}</li>)}</ul></div> : <><p className="muted form-note">変更 {preview.changes.filter(change => change.action === '変更').length}件 ／ 変更なし {preview.changes.filter(change => change.action === '変更なし').length}件</p>{preview.changes.map(change => <details key={change.key} open={change.action === '変更'}><summary><span className="status-tag">{change.action}</span> {change.key}</summary>{change.fields.length > 0 && <div className="table-scroll"><table><thead><tr><th>項目</th><th>現在</th><th>取込後</th></tr></thead><tbody>{change.fields.map(field => <tr key={field.field}><td>{resultFieldLabels[field.field] ?? field.field}</td><td>{String(field.before ?? '—')}</td><td>{String(field.after ?? '—')}</td></tr>)}</tbody></table></div>}</details>)}<label className="field">CSV取込の理由<input aria-label="結果CSV取込の理由" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label><button className="button" disabled={busy || !reason.trim() || !preview.batchId} onClick={() => void confirmImport()}>確認した内容を下書きへ反映</button><p className="muted form-note">取込後も結果は未確定です。下の着順・状態を照合してから「結果を確定」を実行してください。</p></>}</div>}</div></section>;
}

type Metric = { publishedRaces: number; primaryWins: number; primaryWinRatePercent: number | null; primaryTop2RatePercent: number | null; primaryTop3RatePercent: number | null; upHorseSuccessRatePercent: number | null; downHorseFailureRatePercent: number | null; riskHorseFailureRatePercent: number | null; skipped: number; skipRatePercent: number | null };
type Stats = { ruleVersion: string; scope: string; overall: Metric; byConfidence: ({ value: string } & Metric)[]; byVenue: ({ value: string } & Metric)[]; bySurface: ({ value: string } & Metric)[]; byMonth: ({ value: string } & Metric)[] };
const pct = (value: number | null) => value === null ? '—' : `${value.toFixed(1)}%`;
function MetricCards({ value }: { value: Metric }) { return <div className="stats-grid"><section className="stat"><span>公開レース</span><strong>{value.publishedRaces}<small>件</small></strong></section><section className="stat"><span>本命馬1着率</span><strong>{pct(value.primaryWinRatePercent)}</strong></section><section className="stat"><span>本命馬連対率</span><strong>{pct(value.primaryTop2RatePercent)}</strong></section><section className="stat"><span>本命馬複勝率</span><strong>{pct(value.primaryTop3RatePercent)}</strong></section><section className="stat"><span>見送り率</span><strong>{pct(value.skipRatePercent)}</strong></section></div>; }
export function StatsPage() { const [value, setValue] = useState<Stats | null>(null), [error, setError] = useState(''); useEffect(() => { api<Stats>('results/stats').then(setValue).catch(e => setError(e.message)); }, []); return <><div className="page-heading"><span className="eyebrow">PERFORMANCE</span><h1>予想成績</h1><p>確定した各レースの最新結果に対し、公開した馬評価を検証した集計です。</p></div>{error && <div className="notice error">{error}</div>}{value && <><div className="notice">集計範囲：{value.scope} ／ ルール：{value.ruleVersion}</div><MetricCards value={value.overall} /><section className="panel"><div className="panel-heading"><h2>信頼度別</h2></div><div className="table-scroll"><table><thead><tr><th>信頼度</th><th>公開数</th><th>本命1着率</th><th>本命連対率</th><th>本命複勝率</th></tr></thead><tbody>{value.byConfidence.map(row => <tr key={row.value}><td>{row.value === 'SKIP' ? '見送り' : row.value}</td><td>{row.publishedRaces}</td><td>{pct(row.primaryWinRatePercent)}</td><td>{pct(row.primaryTop2RatePercent)}</td><td>{pct(row.primaryTop3RatePercent)}</td></tr>)}</tbody></table></div></section></>}</>; }

type PublicResult = { confirmed: boolean; version?: number; raceCanceled?: boolean; confirmedAt?: string; entries?: { entryId: string; number: number; horseName: string; status: string; finishPosition: number | null }[]; evaluations?: { status: string; primaryFinishedFirst: boolean; primaryFinishedTop2: boolean; primaryFinishedTop3: boolean; winnerInRecommended: boolean; predictionVersion: { version: number; confidence: string } }[] };
const statusLabels: Record<string, string> = { PRIMARY_WIN: '本命馬1着', PRIMARY_TOP2: '本命馬2着', PRIMARY_TOP3: '本命馬3着', WINNER_IN_RECOMMENDED: '勝ち馬を候補内に選出', WINNER_NOT_RECOMMENDED: '勝ち馬は候補外', SKIPPED: '見送り', EXCLUDED: '評価対象外', CANCELED: 'レース中止', REVIEW_REQUIRED: '要確認' };
export function RaceResultPanel({ raceId }: { raceId: string }) { const [value, setValue] = useState<PublicResult | null>(null); useEffect(() => { api<PublicResult>(`races/${raceId}/result`).then(setValue).catch(() => setValue({ confirmed: false })); }, [raceId]); if (!value?.confirmed) return null; return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">OFFICIAL RESULT</span><h2>確定結果</h2></div><span className="status-tag">結果版{value.version}</span></div><div className="panel-body">{value.raceCanceled ? <p>レース中止・評価対象外</p> : <><ol>{value.entries?.filter(entry => entry.status === 'FINISHED').sort((a, b) => (a.finishPosition ?? 99) - (b.finishPosition ?? 99)).map(entry => <li key={entry.entryId}>{entry.finishPosition}着 {entry.number}番 {entry.horseName}</li>)}</ol>{value.evaluations?.map(item => <div className="prediction-total" key={item.predictionVersion.version}><span>公開版{item.predictionVersion.version} · 信頼度 {item.predictionVersion.confidence}</span><strong>{statusLabels[item.status] ?? item.status}</strong></div>)}</>}</div></section>; }
