'use client';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldAlert, ShieldCheck, UserPlus, Users } from 'lucide-react';

type Administrator = { id: string; displayName: string; email: string | null; primaryMfaReady: boolean; backupMfaReady: boolean; createdAt: string };
type Candidate = { id: string; displayName: string; email: string; role: string; createdAt: string };
type Continuity = {
  provider: 'SUPABASE' | 'LOCAL_DEVELOPMENT'; ready: boolean;
  counts: { administrators: number; primaryReady: number; backupReady: number };
  administrators: Administrator[]; candidates: Candidate[];
};

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? '処理に失敗しました。');
  return value as T;
}

export function AdminContinuity({ currentUserId }: { currentUserId: string }) {
  const [data, setData] = useState<Continuity | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(''); try { setData(await request<Continuity>('admin/continuity')); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const candidate = useMemo(() => data?.candidates.find(item => item.id === selectedId), [data, selectedId]);
  async function promote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!candidate) return; setBusy(true); setError(''); setMessage('');
    try {
      await request(`admin/continuity/administrators/${candidate.id}/promote`, 'POST', { confirmationEmail, reason });
      setMessage(`${candidate.displayName}さんを管理者にしました。本人の次回ログインで主・予備の認証アプリを設定してください。`);
      setSelectedId(''); setConfirmationEmail(''); setReason(''); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><span className="eyebrow">ADMIN CONTINUITY</span><h1>管理者の継続運用</h1><p>複数の管理者と予備認証アプリを準備し、端末紛失時にも運用を継続できる状態にします。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    {loading ? <p role="status">準備状況を読み込み中…</p> : data && <>
      <section className={`panel continuity-hero ${data.ready ? 'ready' : 'blocked'}`}><div>{data.ready ? <ShieldCheck /> : <ShieldAlert />}</div><div><span className="eyebrow">CURRENT STATUS</span><h2>{data.ready ? '管理者の予備経路を準備済みです' : '管理者の予備経路を準備してください'}</h2><p>公開前の基準は、管理者2名以上と各管理者の主・予備認証アプリです。</p></div><button className="button secondary small" onClick={() => void load()}><RefreshCw size={15} />再確認</button></section>
      <div className="continuity-counts"><div><span>有効な管理者</span><strong>{data.counts.administrators}<small>/ 2名以上</small></strong></div><div><span>主認証アプリ</span><strong>{data.counts.primaryReady}<small>/ 管理者数</small></strong></div><div><span>予備認証アプリ</span><strong>{data.counts.backupReady}<small>/ 管理者数</small></strong></div></div>
      {data.provider === 'LOCAL_DEVELOPMENT' && <div className="notice">現在は開発用認証です。予備認証アプリはSupabase本番認証へ接続した後に登録できます。</div>}
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ADMINISTRATORS</span><h2>管理者と認証準備</h2></div><Users size={20} /></div><div className="continuity-admins">{data.administrators.map(admin => <article key={admin.id}><div><strong>{admin.displayName}{admin.id === currentUserId && <small>自分</small>}</strong><span>{admin.email ?? 'メール未設定'}</span></div><div className="continuity-status"><span className={admin.primaryMfaReady ? 'ready' : 'blocked'}>{admin.primaryMfaReady ? <CheckCircle2 /> : <ShieldAlert />}主認証</span><span className={admin.backupMfaReady ? 'ready' : 'blocked'}>{admin.backupMfaReady ? <CheckCircle2 /> : <ShieldAlert />}予備認証</span></div>{admin.id === currentUserId && data.provider === 'SUPABASE' && <Link className="button secondary small" href="/security">認証設定</Link>}</article>)}</div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">SECOND ADMIN</span><h2>管理者を追加</h2><small>AAL2で確認済みの管理者だけが、有効な確認済みメール会員を昇格できます。</small></div><UserPlus size={20} /></div><form className="panel-body continuity-form" onSubmit={promote}><label className="field">対象アカウント<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setConfirmationEmail(''); }} required><option value="">選択してください</option>{data.candidates.map(item => <option key={item.id} value={item.id}>{item.displayName}（{item.email}・{item.role}）</option>)}</select></label>{candidate && <><div className="notice">誤操作防止のため、対象者のメールアドレス <strong>{candidate.email}</strong> を入力してください。</div><label className="field">確認用メールアドレス<input type="email" value={confirmationEmail} onChange={event => setConfirmationEmail(event.target.value)} autoComplete="off" required /></label><label className="field">昇格理由<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required placeholder="例：公開日の予備管理者として本人確認済み" /></label><button className="button" disabled={busy}>{busy ? '処理中…' : '管理者にする'}</button></>}</form></section>
      <div className="notice"><ShieldCheck size={18} /><span>独自の復旧コードは発行しません。SupabaseのAAL2境界を維持し、別端末の予備TOTP要素を使います。</span></div>
    </>}
  </>;
}
