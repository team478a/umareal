'use client';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ShieldAlert, ShieldCheck, UserCog, Users } from 'lucide-react';

type StaffRole = 'MEMBER' | 'EXPERT' | 'EDITOR' | 'OPERATOR';
type Account = {
  id: string; displayName: string; email: string; role: StaffRole; registrationMethod: string; disabledAt: string | null; createdAt: string;
  dependencies: { upcomingRaceAssignments: number; activeWin5Products: number; pendingPublicationSchedules: number };
};
type StaffData = {
  accounts: Account[];
  roles: { role: StaffRole; mfaRequired: boolean; win5MfaRequired: boolean; reserved: boolean }[];
  policy: { administratorChangesManagedSeparately: boolean; verifiedEmailRequired: boolean; reasonRequired: boolean; sessionsRevoked: boolean; expertDependenciesProtected: boolean };
};
const labels: Record<StaffRole, string> = { MEMBER: '会員', EXPERT: '専門家', EDITOR: '編集担当（予約）', OPERATOR: '運営担当' };
const descriptions: Record<StaffRole, string> = {
  MEMBER: '会員向け機能を利用します。',
  EXPERT: '担当レースと担当WIN5を編集します。すべてAAL2が必要です。',
  EDITOR: 'CMS導入まで操作機能を持たない予約ロールです。',
  OPERATOR: '開催日運用を担当します。WIN5操作にはAAL2が必要です。'
};

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? '処理に失敗しました。');
  return value as T;
}

export function AdminStaff() {
  const [data, setData] = useState<StaffData | null>(null); const [selectedId, setSelectedId] = useState(''); const [nextRole, setNextRole] = useState<StaffRole | ''>('');
  const [confirmationEmail, setConfirmationEmail] = useState(''); const [reason, setReason] = useState('');
  const [nextExpertId, setNextExpertId] = useState(''); const [transferEmail, setTransferEmail] = useState(''); const [transferReason, setTransferReason] = useState('');
  const [statusEmail, setStatusEmail] = useState(''); const [statusReason, setStatusReason] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(''); try { setData(await request<StaffData>('admin/staff')); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const account = useMemo(() => data?.accounts.find(item => item.id === selectedId), [data, selectedId]);
  const changeableRoles = data?.roles.filter(item => item.role !== account?.role) ?? [];
  const blocked = !!account && account.role === 'EXPERT' && (account.dependencies.upcomingRaceAssignments > 0 || account.dependencies.activeWin5Products > 0);
  const destinationExperts = data?.accounts.filter(item => item.role === 'EXPERT' && item.id !== account?.id) ?? [];
  async function changeRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!account || !nextRole) return; setBusy(true); setError(''); setMessage('');
    try {
      const result = await request<{ nextRole: StaffRole; mfaEnrollmentRequired: boolean; win5MfaRequired: boolean }>(`admin/staff/${account.id}/role`, 'PATCH', { expectedRole: account.role, nextRole, confirmationEmail, reason });
      const authNote = result.mfaEnrollmentRequired ? '次回ログイン後、認証アプリの設定が必要です。' : result.win5MfaRequired ? 'WIN5操作前に認証アプリを設定してください。' : '';
      setMessage(`${account.displayName}さんを「${labels[result.nextRole]}」へ変更しました。現在のローカルセッションは失効しました。${authNote}`);
      setSelectedId(''); setNextRole(''); setConfirmationEmail(''); setReason(''); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!account || !nextExpertId) return; setBusy(true); setError(''); setMessage('');
    try {
      const result = await request<{ nextExpert: { displayName: string }; upcomingRaceAssignments: number; activeWin5Products: number }>(`admin/staff/${account.id}/responsibilities`, 'PATCH', {
        nextExpertId, expectedUpcomingRaceAssignments: account.dependencies.upcomingRaceAssignments, expectedActiveWin5Products: account.dependencies.activeWin5Products,
        confirmationEmail: transferEmail, reason: transferReason
      });
      setMessage(`${account.displayName}さんから${result.nextExpert.displayName}さんへ、今後の担当レース${result.upcomingRaceAssignments}件と有効なWIN5 ${result.activeWin5Products}件を移管しました。`);
      setNextExpertId(''); setTransferEmail(''); setTransferReason(''); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function changeStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!account || account.role === 'MEMBER') return; setBusy(true); setError(''); setMessage('');
    const action = account.disabledAt ? 'RESTORE' : 'SUSPEND';
    try {
      const result = await request<{ status: 'ACTIVE' | 'SUSPENDED' }>(`admin/staff/${account.id}/status`, 'PATCH', { action, expectedRole: account.role, confirmationEmail: statusEmail, reason: statusReason });
      setMessage(`${account.displayName}さんのスタッフアカウントを${result.status === 'ACTIVE' ? '再開' : '停止'}しました。`);
      setStatusEmail(''); setStatusReason(''); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><span className="eyebrow">STAFF ACCESS</span><h1>スタッフ権限管理</h1><p>確認済みアカウントへ担当ロールを設定し、変更履歴と再認証を確実に残します。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    {loading ? <p role="status">スタッフ権限を読み込み中…</p> : data && <>
      <section className="panel staff-policy"><div><ShieldCheck /></div><div><span className="eyebrow">SERVER OWNED ROLES</span><h2>ロールは管理者だけが変更できます</h2><p>対象者のメール再入力と理由を必須にし、変更時に既存のローカルセッションを失効します。管理者の追加は専用画面で行います。</p></div><Link className="button secondary small" href="/admin/continuity">管理者継続運用</Link></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">CURRENT ACCOUNTS</span><h2>確認済みアカウント</h2></div><button className="button secondary small" onClick={() => void load()}><RefreshCw size={15} />再読込</button></div><div className="staff-list">{data.accounts.map(item => { const hasResponsibilities = item.role === 'EXPERT' && !!(item.dependencies.upcomingRaceAssignments || item.dependencies.activeWin5Products); const reset = () => { setSelectedId(item.id); setNextRole(''); setConfirmationEmail(''); setReason(''); setNextExpertId(''); setTransferEmail(''); setTransferReason(''); setStatusEmail(''); setStatusReason(''); }; return <article className={item.disabledAt ? 'suspended' : ''} key={item.id}><div className="staff-person"><span className={`staff-role ${item.role.toLowerCase()}`}>{labels[item.role]}</span><div><strong>{item.displayName}{item.disabledAt && <small className="status-tag warning">停止中</small>}</strong><small>{item.email}</small></div></div><div className="staff-access"><span>{descriptions[item.role]}</span>{item.role === 'EXPERT' && <small className={hasResponsibilities ? 'warning-text' : ''}>今後の担当レース {item.dependencies.upcomingRaceAssignments}件・有効なWIN5 {item.dependencies.activeWin5Products}件</small>}{item.dependencies.pendingPublicationSchedules > 0 && <small className="warning-text">待機・処理中の配信予約 {item.dependencies.pendingPublicationSchedules}件</small>}</div><div className="staff-actions">{item.disabledAt ? <button className="button secondary small" onClick={() => { reset(); window.setTimeout(() => document.getElementById('staff-status-form')?.scrollIntoView({ behavior: 'smooth' }), 0); }}>利用を再開</button> : <><button className="button secondary small" onClick={() => { reset(); window.setTimeout(() => document.getElementById(hasResponsibilities ? 'staff-transfer-form' : 'staff-role-form')?.scrollIntoView({ behavior: 'smooth' }), 0); }}>{hasResponsibilities ? '担当を移管' : '権限を変更'}</button>{item.role !== 'MEMBER' && <button className="button secondary small" onClick={() => { reset(); window.setTimeout(() => document.getElementById('staff-status-form')?.scrollIntoView({ behavior: 'smooth' }), 0); }}>利用を停止</button>}</>}</div></article>; })}</div></section>
      {account && !account.disabledAt && blocked && <section className="panel" id="staff-transfer-form"><div className="panel-heading"><div><span className="eyebrow">RESPONSIBILITY TRANSFER</span><h2>今後の担当を一括移管</h2></div><Users size={20} /></div><form className="panel-body staff-form" onSubmit={transfer}><div className="notice"><span>今後の未終了レース {account.dependencies.upcomingRaceAssignments}件と、JST当日以降の有効なWIN5 {account.dependencies.activeWin5Products}件を移します。過去の担当、公開版、監査履歴は変更しません。</span></div><label className="field">移管先の専門家<select value={nextExpertId} onChange={event => setNextExpertId(event.target.value)} required><option value="">選択してください</option>{destinationExperts.filter(item => !item.disabledAt).map(item => <option value={item.id} key={item.id}>{item.displayName}（{item.email}）</option>)}</select></label>{!destinationExperts.some(item => !item.disabledAt) && <div className="notice error"><ShieldAlert size={18} /><span>移管先にできる別の専門家がいません。先に確認済みアカウントへ専門家ロールを付与してください。</span></div>}<div className="notice">誤操作防止のため、移管元のメールアドレス <strong>{account.email}</strong> を入力してください。</div><label className="field">移管元の確認用メールアドレス<input type="email" value={transferEmail} onChange={event => setTransferEmail(event.target.value)} autoComplete="off" required /></label><label className="field">移管理由<textarea value={transferReason} onChange={event => setTransferReason(event.target.value)} maxLength={500} required placeholder="例：次回開催から担当専門家を交代" /></label><button className="button" disabled={busy || !nextExpertId}>{busy ? '移管中…' : '担当を一括移管'}</button></form></section>}
      <section className="panel" id="staff-role-form"><div className="panel-heading"><div><span className="eyebrow">ROLE CHANGE</span><h2>ロールを変更</h2></div><UserCog size={20} /></div><form className="panel-body staff-form" onSubmit={changeRole}><label className="field">対象アカウント<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setNextRole(''); setConfirmationEmail(''); }} required><option value="">選択してください</option>{data.accounts.filter(item => !item.disabledAt).map(item => <option value={item.id} key={item.id}>{item.displayName}（{item.email}・{labels[item.role]}）</option>)}</select></label>{account && !account.disabledAt && <><div className="staff-role-options" role="radiogroup" aria-label="変更後のロール">{changeableRoles.map(item => <label className={item.reserved ? 'reserved' : ''} key={item.role}><input type="radio" name="nextRole" value={item.role} checked={nextRole === item.role} onChange={() => setNextRole(item.role)} /><span><strong>{labels[item.role]}</strong><small>{descriptions[item.role]}</small></span></label>)}</div>{blocked && <div className="notice error"><ShieldAlert size={18} /><span>専門家ロールを解除する前に、今後の担当レース {account.dependencies.upcomingRaceAssignments}件と有効なWIN5 {account.dependencies.activeWin5Products}件を別の専門家へ移してください。</span></div>}{account.role === 'OPERATOR' && account.dependencies.pendingPublicationSchedules > 0 && <div className="notice error"><ShieldAlert size={18} /><span>運営担当ロールを解除する前に、待機・処理中の配信予約 {account.dependencies.pendingPublicationSchedules}件を取消または完了してください。</span></div>}<div className="notice">誤操作防止のため、対象者のメールアドレス <strong>{account.email}</strong> を入力してください。</div><label className="field">確認用メールアドレス<input type="email" value={confirmationEmail} onChange={event => setConfirmationEmail(event.target.value)} autoComplete="off" required /></label><label className="field">変更理由<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required placeholder="例：次回開催から運営担当として業務を開始" /></label><button className="button" disabled={busy || !nextRole || blocked || (account.role === 'OPERATOR' && account.dependencies.pendingPublicationSchedules > 0)}>{busy ? '処理中…' : 'ロールを変更'}</button></>}</form></section>
      {account && account.role !== 'MEMBER' && <section className="panel" id="staff-status-form"><div className="panel-heading"><div><span className="eyebrow">ACCOUNT STATUS</span><h2>スタッフ利用を{account.disabledAt ? '再開' : '停止'}</h2></div><ShieldAlert size={20} /></div><form className="panel-body staff-form" onSubmit={changeStatus}>{account.disabledAt ? <div className="notice">スタッフロールを維持したままログインを再開します。再開後は本人の次回ログインから新しいセッションが作成されます。</div> : <><div className="notice">ログインとAPI利用を即時停止し、ローカルセッションを失効します。ロール、通知設定、LINE連携、過去履歴は保持します。</div>{(blocked || account.dependencies.pendingPublicationSchedules > 0) && <div className="notice error"><ShieldAlert size={18} /><span>担当レース、WIN5、待機・処理中の配信予約を移管または完了してから停止してください。</span></div>}<div className="notice">有効または申込中の契約、1日利用、将来を含む閲覧権限がある場合も、会員アクセス保護のため停止を拒否します。</div></>}<div className="notice">確認のため、対象者のメールアドレス <strong>{account.email}</strong> を入力してください。</div><label className="field">確認用メールアドレス<input type="email" value={statusEmail} onChange={event => setStatusEmail(event.target.value)} autoComplete="off" required /></label><label className="field">{account.disabledAt ? '再開' : '停止'}理由<textarea value={statusReason} onChange={event => setStatusReason(event.target.value)} maxLength={500} required /></label><button className="button" disabled={busy || (!account.disabledAt && (blocked || account.dependencies.pendingPublicationSchedules > 0))}>{busy ? '処理中…' : `スタッフ利用を${account.disabledAt ? '再開' : '停止'}`}</button></form></section>}
      <div className="notice"><Users size={18} /><span>編集担当は将来のCMS用に保持している予約ロールです。現時点では編集画面へアクセスできません。</span></div>
    </>}
  </>;
}
