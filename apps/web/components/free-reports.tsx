'use client';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowRight, Eye, Mic, PlayCircle, Square, Upload } from 'lucide-react';
import type { AdminFreeMemberBenefitResponse, AdminFreeReportAudioUploadResponse, AdminFreeReportDraftResponse, AdminFreeReportPublishResponse, AdminFreeReportRaceDetailResponse, AdminFreeReportRaceListResponse, FreeReportNotificationPreviewResponse, NotificationTestSendResponse, PublicFreeMemberBenefitResponse, PublicFreeMemberBenefitViewResponse } from '@keiba/domain';
import { NotificationPreview } from './notification-preview';

type Draft = Pick<AdminFreeReportDraftResponse, 'revision' | 'upEntryId' | 'upReason' | 'downEntryId' | 'downReason' | 'audioUrl' | 'reviewText'>;
const draftForm = (value: Draft): Draft => ({ revision: value.revision, upEntryId: value.upEntryId, upReason: value.upReason, downEntryId: value.downEntryId, downReason: value.downReason, audioUrl: value.audioUrl, reviewText: value.reviewText });
type BenefitForm = Pick<AdminFreeMemberBenefitResponse, 'revision' | 'title' | 'description' | 'videoUrl'>;
const benefitForm = (value: AdminFreeMemberBenefitResponse): BenefitForm => ({ revision: value.revision, title: value.title, description: value.description, videoUrl: value.videoUrl });

async function api<T>(path: string, method = 'GET', body?: unknown, idempotent = false): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, cache: 'no-store', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); if (!response.ok) throw new Error(value.message ?? '処理に失敗しました。'); return value;
}
const jstDate = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const jstDateTime = (value: string) => new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

function AudioInput({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const recorder = useRef<MediaRecorder | null>(null); const stream = useRef<MediaStream | null>(null); const chunks = useRef<Blob[]>([]); const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [recording, setRecording] = useState(false); const [uploading, setUploading] = useState(false); const [seconds, setSeconds] = useState(0); const [error, setError] = useState('');
  function release() { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (timer.current) clearInterval(timer.current); timer.current = null; }
  useEffect(() => () => release(), []);
  async function uploadAudio(blob: Blob) {
    if (!blob.size) { setError('音声が録音されませんでした。'); return; }
    if (blob.size > 8 * 1024 * 1024) { setError('音声は8MB以下にしてください。短く録音してください。'); return; }
    setUploading(true); setError('');
    try {
      const contentType = blob.type.split(';')[0] || 'audio/webm';
      const response = await fetch('/api/v1/admin/free-reports/audio', { method: 'POST', headers: { 'Content-Type': contentType }, body: blob });
      const result = await response.json() as AdminFreeReportAudioUploadResponse & { message?: string }; if (!response.ok) throw new Error(result.message ?? '音声を保存できませんでした。');
      onChange(result.url);
    } catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  async function start() {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('このブラウザでは録音できません。音声ファイルを選択してください。'); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']; const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined); recorder.current = next; chunks.current = []; setSeconds(0);
      next.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data); };
      next.onstop = () => { const blob = new Blob(chunks.current, { type: next.mimeType || mimeType || 'audio/webm' }); release(); setRecording(false); void uploadAudio(blob); };
      next.start(1000); setRecording(true);
      timer.current = setInterval(() => setSeconds(current => { if (current >= 299 && next.state === 'recording') next.stop(); return current + 1; }), 1000);
    } catch { release(); setError('マイクを利用できません。ブラウザのマイク許可を確認してください。'); }
  }
  function stop() { if (recorder.current?.state === 'recording') recorder.current.stop(); }
  async function selectFile(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; event.target.value = ''; if (file) await uploadAudio(file); }
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <div className="audio-input"><div className="audio-input-actions">{recording ? <button type="button" className="button recording" onClick={stop}><Square size={17} /> 録音を終了 {clock}</button> : <button type="button" className="button" disabled={disabled || uploading} onClick={() => void start()}><Mic size={17} /> マイクで録音</button>}<label className={`button secondary audio-file-button ${disabled || recording || uploading ? 'disabled' : ''}`}><Upload size={17} /> 音声ファイルを選択<input type="file" accept="audio/*" disabled={disabled || recording || uploading} onChange={e => void selectFile(e)} /></label></div>{uploading && <p className="muted" role="status">音声を保存しています…</p>}{error && <p className="field-error" role="alert">{error}</p>}{value && <audio controls preload="metadata" src={value}>音声を再生できません。</audio>}<details><summary>外部の音声URLを使う</summary><label className="field">音声URL<input type="text" maxLength={1000} required value={value} placeholder="https://..." onChange={e => onChange(e.target.value)} /></label></details><p className="muted form-note">音声は最大8MB。マイク録音は5分で自動終了し、下書き保存前に試聴できます。</p></div>;
}

export function FreeReportManager({ canTest = false }: { canTest?: boolean }) {
  const [date, setDate] = useState(jstDate()); const [races, setRaces] = useState<AdminFreeReportRaceListResponse['items']>([]); const [detail, setDetail] = useState<AdminFreeReportRaceDetailResponse | null>(null);
  const [draft, setDraft] = useState<Draft>({ revision: 0, upEntryId: '', upReason: '', downEntryId: '', downReason: '', audioUrl: '', reviewText: '' });
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [testBusy, setTestBusy] = useState<'LINE' | 'EMAIL' | null>(null); const [preview, setPreview] = useState<FreeReportNotificationPreviewResponse | null>(null);
  async function loadRaces(value = date) { try { setRaces((await api<AdminFreeReportRaceListResponse>(`admin/free-reports/races?date=${value}`)).items); } catch (e) { setError((e as Error).message); } }
  async function open(id: string) { setError(''); setPreview(null); try { const value = await api<AdminFreeReportRaceDetailResponse>(`admin/free-reports/races/${id}`); setDetail(value); setDraft(value.freeReportDraft ? draftForm(value.freeReportDraft) : { revision: 0, upEntryId: value.entries[0]?.id ?? '', upReason: '', downEntryId: value.entries[1]?.id ?? '', downReason: '', audioUrl: '', reviewText: '' }); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void loadRaces(date); setDetail(null); }, [date]);
  async function saveDraft(event: FormEvent) { event.preventDefault(); if (!detail) return; setBusy(true); setError(''); setMessage(''); try { const value = await api<AdminFreeReportDraftResponse>(`admin/free-reports/races/${detail.id}/draft`, 'PATCH', { ...draft, reason }); setDraft(draftForm(value)); setReason(''); setMessage('無料速報の下書きを保存しました。'); await open(detail.id); await loadRaces(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function publish(kind: 'PRE_RACE' | 'POST_RACE_REVIEW') { if (!detail) return; setBusy(true); setError(''); setMessage(''); try { await api<AdminFreeReportPublishResponse>(`admin/free-reports/races/${detail.id}/publish`, 'POST', { revision: draft.revision, kind, reason }, true); setMessage(kind === 'PRE_RACE' ? '無料パドック速報を公開しました。' : 'レース後検証を公開しました。'); setReason(''); await open(detail.id); await loadRaces(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function loadPreview(kind: 'PRE_RACE' | 'POST_RACE_REVIEW') { if (!detail) return; setBusy(true); setError(''); setMessage(''); try { setPreview(await api<FreeReportNotificationPreviewResponse>(`admin/notifications/previews/free-report?raceId=${detail.id}&kind=${kind}&revision=${draft.revision}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function testSend(channel: 'LINE' | 'EMAIL') { if (!detail || !preview?.kind) return; setTestBusy(channel); setError(''); setMessage(''); try { const result = await api<NotificationTestSendResponse>('admin/notifications/test-send', 'POST', { raceId: detail.id, contentType: preview.kind === 'PRE_RACE' ? 'FREE_REPORT_PRE_RACE' : 'FREE_REPORT_POST_RACE_REVIEW', draftRevision: draft.revision, channel, reason }, true); setMessage(`${channel === 'EMAIL' ? 'メール' : 'LINE'}の${result.status === 'SIMULATED' ? '模擬テスト送信' : 'テスト送信'}を完了しました。`); } catch (e) { setError((e as Error).message); } finally { setTestBusy(null); } }
  const active = detail?.entries.filter(entry => entry.status === 'ACTIVE') ?? [];
  const storedDraft = detail?.freeReportDraft;
  const draftChanged = !!detail && (!storedDraft || storedDraft.upEntryId !== draft.upEntryId || storedDraft.upReason !== draft.upReason || storedDraft.downEntryId !== draft.downEntryId || storedDraft.downReason !== draft.downReason || storedDraft.audioUrl !== draft.audioUrl || storedDraft.reviewText !== draft.reviewText);
  return <><div className="page-heading"><span className="eyebrow">FREE RACE REPORT</span><h1>無料速報を作成</h1><p>毎週の無料パドック速報を作成し、配信内容を確認して公開します。</p></div>{error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <section className="panel"><div className="panel-heading"><h2>対象レース</h2><label className="date-filter">開催日<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label></div>{races.length ? <div className="race-list">{races.map(race => <div className="race-row" key={race.id}><div className="race-number">{race.number}<small>R</small></div><div className="race-info"><span className="muted">{race.venue} · 出走馬{race._count.entries}頭</span><h3>{race.name}</h3><small>{race.freeReportVersions[0] ? `公開済み 第${race.freeReportVersions[0].version}版` : race.freeReportDraft ? '下書きあり' : '未作成'}</small></div><button className="button secondary small" onClick={() => void open(race.id)}>編集</button></div>)}</div> : <div className="empty"><h3>対象レースがありません</h3><p>レース管理で登録した開催日を選択してください。</p></div>}</section>
    {detail && <section className="panel" id="free-report-editor"><div className="panel-heading"><div><span className="eyebrow">{detail.venue} {detail.number}R</span><h2>{detail.name}</h2></div><span className="status-tag">下書き v{draft.revision}</span></div><form className="panel-body" onSubmit={saveDraft}><div className="two-columns"><div><label className="field">評価UP馬<select value={draft.upEntryId} required onChange={e => { setDraft({ ...draft, upEntryId: e.target.value }); setPreview(null); }}><option value="">選択してください</option>{active.map(entry => <option value={entry.id} key={entry.id}>{entry.number}番 {entry.horseName}</option>)}</select></label><label className="field">評価を上げた理由<textarea rows={4} maxLength={1000} required value={draft.upReason} onChange={e => { setDraft({ ...draft, upReason: e.target.value }); setPreview(null); }} /></label></div><div><label className="field">評価DOWN馬<select value={draft.downEntryId} required onChange={e => { setDraft({ ...draft, downEntryId: e.target.value }); setPreview(null); }}><option value="">選択してください</option>{active.map(entry => <option value={entry.id} key={entry.id}>{entry.number}番 {entry.horseName}</option>)}</select></label><label className="field">評価を下げた理由<textarea rows={4} maxLength={1000} required value={draft.downReason} onChange={e => { setDraft({ ...draft, downReason: e.target.value }); setPreview(null); }} /></label></div></div><div className="field"><span>本人音声</span><AudioInput value={draft.audioUrl} disabled={busy} onChange={audioUrl => { setDraft({ ...draft, audioUrl }); setPreview(null); }} /></div><label className="field">レース後の簡易検証<textarea rows={4} maxLength={2000} value={draft.reviewText} placeholder="確定結果の登録後に入力します" onChange={e => { setDraft({ ...draft, reviewText: e.target.value }); setPreview(null); }} /></label><label className="field">保存・公開理由<input maxLength={500} required value={reason} onChange={e => setReason(e.target.value)} /></label><div className="panel-actions"><button className="button secondary" disabled={busy || !draft.audioUrl}>下書きを保存</button><button type="button" className="button secondary" disabled={busy || draftChanged || !draft.revision || !reason.trim() || new Date() >= new Date(detail.startsAt)} onClick={() => void loadPreview('PRE_RACE')}><Eye size={16} />発走前速報の配信内容を確認</button><button type="button" className="button secondary" disabled={busy || draftChanged || !draft.revision || !reason.trim() || !draft.reviewText.trim() || !detail.resultVersions.length || new Date() < new Date(detail.startsAt)} onClick={() => void loadPreview('POST_RACE_REVIEW')}><Eye size={16} />レース後検証の配信内容を確認</button></div>{draftChanged && <p className="muted form-note">変更内容を下書き保存すると、配信内容を確認できます。</p>}{preview?.kind && <NotificationPreview preview={preview} busy={busy || !!testBusy} testAction={canTest ? { busy: testBusy, onSend: channel => void testSend(channel) } : undefined} action={{ label: preview.kind === 'PRE_RACE' ? 'この内容で発走前速報を公開' : 'この内容でレース後検証を公開', onClick: () => void publish(preview.kind!) }} />}</form>{detail.freeReportVersions.length > 0 && <div className="panel-body"><h3>公開履歴</h3>{detail.freeReportVersions.map(version => <p key={version.id}>第{version.version}版 · {version.kind === 'PRE_RACE' ? '発走前速報' : 'レース後検証'} · {new Date(version.publishedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p>)}</div>}</section>}
  </>;
}

export function RegistrationBenefitManager() {
  const [current, setCurrent] = useState<AdminFreeMemberBenefitResponse | null>(null);
  const [form, setForm] = useState<BenefitForm>({ revision: 0, title: '', description: '', videoUrl: '' });
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function load() {
    setError('');
    try { const value = await api<AdminFreeMemberBenefitResponse>('admin/free-reports/benefit'); setCurrent(value); setForm(benefitForm(value)); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const value = await api<AdminFreeMemberBenefitResponse>('admin/free-reports/benefit', 'PATCH', { ...form, reason });
      setCurrent(value); setForm(benefitForm(value)); setReason(''); setMessage('登録特典を保存し、現在の一覧へ反映しました。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const configured = !!current && current.revision > 0;
  return <><div className="page-heading"><span className="eyebrow">REGISTRATION BENEFIT</span><h1>登録特典を管理</h1><p>LINEから無料登録した会員へ表示する特典動画を確認・更新します。</p></div>{error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <section className="panel" aria-labelledby="current-benefit-title"><div className="panel-heading"><div><span className="eyebrow">CURRENT BENEFIT</span><h2 id="current-benefit-title">登録特典一覧</h2></div><span className={`count-tag ${configured ? '' : 'warning'}`}>{configured ? '1件' : '0件'}</span></div>{current === null && !error ? <div className="empty" role="status">登録特典を確認中…</div> : configured && current ? <><div className="admin-benefit-current"><div className="admin-benefit-current-heading"><div><span className="status-tag">公開中</span><h3>{current.title}</h3></div><PlayCircle size={28} /></div><p>{current.description}</p><dl className="admin-benefit-meta"><div><dt>動画URL</dt><dd><a href={current.videoUrl} target="_blank" rel="noreferrer">{current.videoUrl}</a></dd></div><div><dt>現在の版</dt><dd>第{current.revision}版</dd></div><div><dt>最終更新</dt><dd>{current.updatedAt ? `${jstDateTime(current.updatedAt)} JST` : '未更新'}</dd></div></dl></div><div className="benefit-audience" aria-label="登録特典の利用状況"><div><span>対象会員</span><strong>{current.audience.eligibleMembers}<small>人</small></strong></div><div><span>視聴開始済み</span><strong>{current.audience.viewedMembers}<small>人</small></strong></div></div><p className="admin-benefit-slot-note">現在の登録特典は1件です。下のフォームを保存すると、この内容が新しい版へ更新されます。</p></> : !error && <div className="empty"><PlayCircle size={32} /><h3>登録特典はまだありません</h3><p>下のフォームから最初の特典動画を設定してください。</p></div>}</section>
    <section className="panel" aria-labelledby="benefit-editor-title"><div className="panel-heading"><div><span className="eyebrow">EDIT BENEFIT</span><h2 id="benefit-editor-title">{configured ? '登録特典を更新' : '登録特典を設定'}</h2></div><PlayCircle size={22} /></div><form className="panel-body" onSubmit={save}><p className="form-note">LINEから新規登録した一般会員だけに表示します。メール登録後にLINEを連携した会員は対象外です。</p><label className="field">タイトル<input value={form.title} maxLength={120} required onChange={e => setForm({ ...form, title: e.target.value })} /></label><label className="field">説明<textarea rows={3} value={form.description} maxLength={1000} required onChange={e => setForm({ ...form, description: e.target.value })} /></label><label className="field">動画URL（HTTPS）<input type="url" value={form.videoUrl} maxLength={1000} required placeholder="https://..." onChange={e => setForm({ ...form, videoUrl: e.target.value })} /></label><label className="field">変更理由<input value={reason} maxLength={500} required placeholder="例：特典動画を最新版へ差し替えるため" onChange={e => setReason(e.target.value)} /></label><button className="button" disabled={busy || current === null}>{busy ? '保存中…' : configured ? '現在の登録特典を更新' : '登録特典を設定'}</button></form></section>
  </>;
}

export function RegistrationBenefit({ highlight = false }: { highlight?: boolean }) {
  const [value, setValue] = useState<PublicFreeMemberBenefitResponse | null>(null);
  useEffect(() => { api<PublicFreeMemberBenefitResponse>('me/free-benefit').then(setValue).catch(() => setValue({ configured: false })); }, []);
  if (!value?.configured) return null;
  return <section className={`panel registration-benefit ${highlight ? 'highlight' : ''}`} aria-labelledby="registration-benefit-title"><div className="panel-heading"><div><span className="eyebrow">LINE REGISTRATION BONUS</span><h2 id="registration-benefit-title">{highlight ? '登録特典を受け取れます' : value.title}</h2></div><PlayCircle size={24} /></div><div className="panel-body">{highlight && <strong className="benefit-title">{value.title}</strong>}<p>{value.description}</p><Link className="button" href="/benefit">{value.viewedAt ? '特典動画をもう一度見る' : '特典動画を見る'} <ArrowRight size={17} /></Link>{value.viewedAt && <small className="benefit-viewed">視聴開始済み。マイページからいつでも確認できます。</small>}</div></section>;
}

export function RegistrationBenefitPage() {
  const [value, setValue] = useState<PublicFreeMemberBenefitResponse | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { api<PublicFreeMemberBenefitResponse>('me/free-benefit').then(setValue).catch(e => setError((e as Error).message)); }, []);
  async function watch() {
    setBusy(true); setError('');
    try { const result = await api<PublicFreeMemberBenefitViewResponse>('me/free-benefit/view', 'POST'); window.location.assign(result.videoUrl); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <><div className="page-heading"><span className="eyebrow">LINE REGISTRATION BONUS</span><h1>登録特典</h1><p>LINE無料登録を完了した方へお渡しする動画です。</p></div>{error && <div className="notice error" role="alert">{error}</div>}{value === null && !error ? <div className="loading" role="status">登録特典を確認中…</div> : value?.configured ? <section className="panel benefit-page"><div className="benefit-page-icon"><PlayCircle size={42} /></div><div><span className="eyebrow">SPECIAL MOVIE</span><h2>{value.title}</h2><p>{value.description}</p><button type="button" className="button" disabled={busy} onClick={() => void watch()}>{busy ? '動画を開いています…' : value.viewedAt ? 'もう一度見る' : '動画を見る'}<ArrowRight size={17} /></button><small>動画は管理された外部配信ページで開きます。URLの共有はお控えください。</small></div></section> : <section className="panel"><div className="empty"><PlayCircle size={32} /><h3>表示できる登録特典はありません</h3><p>この動画は、LINEから無料登録を完了した会員向けです。</p><Link className="button secondary" href="/account">マイページへ戻る</Link></div></section>}</>;
}
