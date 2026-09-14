'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Clock3, Copy, MailCheck, RefreshCw, UserRoundCheck } from 'lucide-react';

type FollowupItem = {
  id: string; displayName: string; email: string; createdAt: string; status: 'RECENT' | 'OVERDUE';
  lastVerification: { createdAt: string; expiresAt: string; usedAt: string | null } | null;
  canResend: boolean; resendAvailableAt: string | null;
};
type FollowupResponse = {
  items: FollowupItem[]; total: number; page: number; limit: number;
  counts: { pending: number; recent: number; overdue: number };
  resendMode: 'ADMIN_DIRECT' | 'MEMBER_SELF_SERVICE'; selfServicePath: string;
};

const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const elapsed = (value: string, now: number) => { const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000)); return minutes < 60 ? `${minutes}分` : minutes < 1440 ? `${Math.floor(minutes / 60)}時間` : `${Math.floor(minutes / 1440)}日`; };
async function request<T>(path: string, init?: RequestInit) { const response = await fetch(`/api/v1/${path}`, { cache: 'no-store', ...init }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? '処理に失敗しました。'); return body as T; }

export function RegistrationFollowups() {
  const [data, setData] = useState<FollowupResponse | null>(null); const [status, setStatus] = useState<'ALL' | 'RECENT' | 'OVERDUE'>('ALL'); const [page, setPage] = useState(1);
  const [reasons, setReasons] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(''); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => { setLoading(true); setError(''); try { setData(await request<FollowupResponse>(`admin/registration-followups?status=${status}&page=${page}`)); } catch (cause) { setError((cause as Error).message); } finally { setLoading(false); } }, [status, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  async function resend(item: FollowupItem) { const reason = reasons[item.id]?.trim(); if (!reason) { setError('再送理由を入力してください。'); return; } setBusy(item.id); setError(''); setMessage(''); try { const result = await request<{ message: string }>(`admin/registration-followups/${item.id}/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); setMessage(`${item.displayName}さんへ${result.message}`); setReasons(value => ({ ...value, [item.id]: '' })); await load(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(''); } }
  async function copyLink() { const url = `${window.location.origin}${data?.selfServicePath ?? '/verify-email'}`; try { await navigator.clipboard.writeText(url); setMessage('本人確認メールの再送ページURLをコピーしました。'); } catch { setError('URLをコピーできませんでした。'); } }
  const direct = data?.resendMode === 'ADMIN_DIRECT';
  return <>
    <div className="page-heading"><span className="eyebrow">REGISTRATION FOLLOW-UP</span><h1>本人確認フォロー</h1><p>無料登録後、メール確認が完了していない会員を確認します。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    {data && <div className="followup-metrics" aria-label="本人確認待ち集計"><div><span>確認待ち</span><strong>{data.counts.pending}<small>人</small></strong></div><div><span>登録30分以内</span><strong>{data.counts.recent}<small>人</small></strong></div><div className={data.counts.overdue ? 'warning' : ''}><span>30分以上経過</span><strong>{data.counts.overdue}<small>人</small></strong></div></div>}
    <section className="panel followup-guidance"><MailCheck size={25} /><div><strong>{direct ? '管理者から再送できます' : '会員本人のブラウザーから再送します'}</strong><p>{direct ? '対象メールアドレスを確認して理由を記録します。再送後5分間は重複送信できません。' : 'Supabaseの確認処理には本人ブラウザーの情報が必要です。会員へ再送ページを案内してください。メールアドレスはURLに含まれません。'}</p></div>{!direct && <button className="button secondary small" onClick={() => void copyLink()}><Copy size={15} />再送ページURLをコピー</button>}</section>
    <section className="panel followup-panel"><div className="panel-heading followup-heading"><div><span className="eyebrow">PENDING MEMBERS</span><h2>確認待ち会員</h2></div><div className="followup-filters"><label>状態<select value={status} onChange={event => { setStatus(event.target.value as typeof status); setPage(1); }}><option value="ALL">すべて</option><option value="OVERDUE">30分以上</option><option value="RECENT">30分以内</option></select></label><button className="button secondary small" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />更新</button></div></div>
      {loading && !data ? <div className="panel-body" role="status">確認待ち会員を読み込み中…</div> : data?.items.length ? <div className="followup-list">{data.items.map(item => { const available = direct && (!item.resendAvailableAt || new Date(item.resendAvailableAt).getTime() <= now); return <article className={`followup-row ${item.status.toLowerCase()}`} key={item.id}><div className="followup-member"><span className="followup-icon"><UserRoundCheck size={20} /></span><div><strong>{item.displayName}</strong><small>{item.email}</small></div><span className={`status-tag ${item.status === 'OVERDUE' ? 'warning' : ''}`}>{item.status === 'OVERDUE' ? '要確認' : '確認待ち'}</span></div><div className="followup-timing"><span><Clock3 size={15} />登録から {elapsed(item.createdAt, now)}</span><small>登録：{formatDate(item.createdAt)} JST</small><small>{item.lastVerification ? `直近送信：${formatDate(item.lastVerification.createdAt)} JST` : '送信履歴なし'}</small></div>{direct ? <div className="followup-action"><label className="field">再送理由<input aria-label={`${item.email}への再送理由`} value={reasons[item.id] ?? ''} maxLength={500} onChange={event => setReasons(value => ({ ...value, [item.id]: event.target.value }))} placeholder="例：会員から未着の連絡" /></label><button className="button small" aria-label={`${item.email}へ確認メールを再送`} disabled={busy === item.id || !available} onClick={() => void resend(item)}>{busy === item.id ? '送信中…' : available ? '確認メールを再送' : '5分間隔で再送'}<ArrowRight size={15} /></button></div> : <div className="followup-self-service"><strong>本人操作を案内</strong><small>{data.selfServicePath}</small></div>}</article>; })}</div> : <div className="empty"><MailCheck size={32} /><h3>確認待ち会員はいません</h3><p>選択した条件では、対応が必要な無料登録はありません。</p></div>}
      {data && <div className="pagination"><span>全{data.total}件 · {page}ページ</span><button className="button secondary small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>前へ</button><button className="button secondary small" disabled={page * data.limit >= data.total} onClick={() => setPage(value => value + 1)}>次へ</button></div>}
    </section>
  </>;
}
