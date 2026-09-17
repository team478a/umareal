'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MessageCircle, RefreshCw } from 'lucide-react';

type Status = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
type Category = 'ACCOUNT' | 'NOTIFICATION' | 'CONTENT' | 'TECHNICAL' | 'SERVICE' | 'OTHER';
type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
type MemberItem = { id: string; category: Category; subject: string; message: string; status: Status; createdAt: string; updatedAt: string; events: { id: string; eventType: string; actorRole: string; publicMessage: string; occurredAt: string }[] };
type Assignee = { id: string; displayName: string; role: 'ADMIN' | 'OPERATOR' };
type AdminItem = Omit<MemberItem, 'events'> & { priority: Priority; assignedToId: string | null; dueAt: string | null; assignee: (Assignee & { disabledAt?: string | null }) | null; user: { id: string; displayName: string; email: string | null }; events: { id: string; eventType: string; actorRole: string; reason: string; publicMessage: string | null; occurredAt: string; actor: { displayName: string } }[] };

const categoryLabels: Record<Category, string> = { ACCOUNT: 'アカウント・ログイン', NOTIFICATION: 'LINE・メール通知', CONTENT: '予想・掲載内容', TECHNICAL: '画面・操作の不具合', SERVICE: 'サービスについて', OTHER: 'その他' };
const statusLabels: Record<Status, string> = { OPEN: '受付済み', IN_PROGRESS: '確認中', RESOLVED: '回答済み' };
const eventLabels: Record<string, string> = { CREATED: '問い合わせ受付', MEMBER_MESSAGE: '会員からの追加情報', IN_PROGRESS: '確認開始', RESOLVED: '回答・解決', REOPENED: '受付再開', TRIAGED: '振り分け変更' };
const priorityLabels: Record<Priority, string> = { LOW: '低', NORMAL: '通常', HIGH: '高', URGENT: '緊急' };
const date = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const localDateTime = (value: string | null) => { if (!value) return ''; const at = new Date(value); return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

async function request<T>(path: string, method = 'GET', body?: unknown, idempotent = false): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, cache: 'no-store', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理に失敗しました。');
  return result as T;
}

function Notice({ value, error = false }: { value: string; error?: boolean }) { return value ? <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{value}</div> : null; }

function MemberSupportItem({ item, onUpdated }: { item: MemberItem; onUpdated: () => Promise<void> }) {
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  async function addMessage(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(''); setError('');
    try {
      const wasResolved = item.status === 'RESOLVED';
      await request(`support/requests/${item.id}/messages`, 'POST', { message }, true);
      setMessage(''); setNotice(wasResolved ? '追加質問を受け付け、問い合わせを再開しました。' : '追加情報を送信しました。'); await onUpdated();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <article className="support-item"><div className="support-item-head"><div><span className="eyebrow">{categoryLabels[item.category]}</span><h3>{item.subject}</h3></div><span className={`status-tag ${item.status === 'RESOLVED' ? '' : 'warning'}`}>{statusLabels[item.status]}</span></div>
    <div className="support-thread-message member"><strong>最初のお問い合わせ</strong><p>{item.message}</p><small>{date(item.createdAt)} JST</small></div>
    {item.events.map(event => <div className={`support-thread-message ${event.actorRole === 'MEMBER' ? 'member' : 'staff'}`} key={event.id}><strong>{event.actorRole === 'MEMBER' ? 'あなたからの追加情報' : '運営からの回答'}</strong><p>{event.publicMessage}</p><small>{date(event.occurredAt)} JST</small></div>)}
    <Notice value={error} error /><Notice value={notice} />
    <form className="support-response" onSubmit={addMessage}><label className="field">{item.status === 'RESOLVED' ? '追加で質問する' : '追加情報を送る'}<textarea value={message} onChange={event => setMessage(event.target.value)} minLength={2} maxLength={2000} rows={3} required placeholder={item.status === 'RESOLVED' ? '回答について追加で確認したい内容を入力してください。送信すると受付を再開します。' : '確認に役立つ追加情報を入力してください。'} /></label><div className="review-actions"><button className="button secondary small" disabled={busy || message.trim().length < 2}>{busy ? '送信中…' : item.status === 'RESOLVED' ? '追加質問して再開' : '追加情報を送信'}</button></div></form>
  </article>;
}

export function MemberSupport() {
  const [items, setItems] = useState<MemberItem[]>([]); const [category, setCategory] = useState<Category>('SERVICE');
  const [subject, setSubject] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setItems((await request<{ items: MemberItem[] }>('support/me')).items); setError(''); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(''); setError('');
    try { await request('support/requests', 'POST', { category, subject, message }, true); setSubject(''); setMessage(''); setNotice('お問い合わせを受け付けました。回答はこちらの画面で確認できます。'); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><div className="page-heading"><span className="eyebrow">SUPPORT</span><h1>お問い合わせ</h1><p>操作方法やサービスについて、運営へ問い合わせできます。</p></div><Notice value={error} error /><Notice value={notice} />
    <section className="panel support-compose"><div className="panel-heading"><div><span className="eyebrow">NEW MESSAGE</span><h2>新しいお問い合わせ</h2></div><MessageCircle size={22} /></div><form onSubmit={submit}><div className="panel-body support-form"><label className="field">お問い合わせの種類<select value={category} onChange={event => setCategory(event.target.value as Category)}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">件名<input value={subject} onChange={event => setSubject(event.target.value)} minLength={5} maxLength={120} required placeholder="例：LINE通知が届きません" /></label><label className="field">詳しい内容<textarea value={message} onChange={event => setMessage(event.target.value)} minLength={10} maxLength={4000} rows={6} required placeholder="発生した状況や確認してほしい内容を入力してください。秘密情報やパスワードは入力しないでください。" /></label></div><div className="panel-actions"><p>回答後も過去のお問い合わせを確認できます。</p><button className="button" disabled={busy || subject.trim().length < 5 || message.trim().length < 10}>{busy ? '送信中…' : '問い合わせを送信'}</button></div></form></section>
    <section className="panel"><div className="panel-heading"><h2>お問い合わせ履歴</h2><button className="button secondary small" onClick={() => void load()}><RefreshCw size={15} />更新</button></div>{!items.length ? <div className="panel-body"><p className="muted">お問い合わせ履歴はありません。</p></div> : <div className="support-list">{items.map(item => <MemberSupportItem item={item} key={item.id} onUpdated={load} />)}</div>}</section></>;
}

function AdminSupportItem({ item, assignees, onUpdated }: { item: AdminItem; assignees: Assignee[]; onUpdated: () => Promise<void> }) {
  const [reason, setReason] = useState(''); const [reply, setReply] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [priority, setPriority] = useState<Priority>(item.priority); const [assignedToId, setAssignedToId] = useState(item.assignedToId ?? ''); const [dueAt, setDueAt] = useState(localDateTime(item.dueAt)); const [triageReason, setTriageReason] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => { setPriority(item.priority); setAssignedToId(item.assignedToId ?? ''); setDueAt(localDateTime(item.dueAt)); }, [item.priority, item.assignedToId, item.dueAt]);
  async function update(status: Status) {
    setBusy(true); setError('');
    try { await request(`admin/support/${item.id}/status`, 'POST', { status, reason, publicReply: status === 'RESOLVED' ? reply : null }); setReason(''); setReply(''); await onUpdated(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function saveTriage(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try { await request(`admin/support/${item.id}/triage`, 'POST', { priority, assignedToId: assignedToId || null, dueAt: dueAt ? new Date(dueAt).toISOString() : null, reason: triageReason }); setTriageReason(''); setNotice('担当・優先度・対応期限を更新しました。'); await onUpdated(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const overdue = item.status !== 'RESOLVED' && !!item.dueAt && new Date(item.dueAt) < new Date();
  return <article className={`support-item ${overdue ? 'support-overdue' : ''}`}><div className="support-item-head"><div><span className="eyebrow">{categoryLabels[item.category]}</span><h3>{item.subject}</h3></div><div className="support-tags"><span className={`priority-tag priority-${item.priority.toLowerCase()}`}>優先度 {priorityLabels[item.priority]}</span><span className={`status-tag ${item.status === 'RESOLVED' ? '' : 'warning'}`}>{statusLabels[item.status]}</span></div></div><p>{item.message}</p><small>{item.user.displayName} · {item.user.email ?? 'メール未設定'} · {date(item.createdAt)} JST</small><div className="support-assignment-summary"><strong>担当：{item.assignee?.displayName ?? '未割当'}</strong><span className={overdue ? 'deadline-overdue' : ''}>{item.dueAt ? `${overdue ? '期限超過：' : '対応期限：'}${date(item.dueAt)} JST` : '対応期限：未設定'}</span></div>
    {!!item.events.length && <details open={item.events.some(event => event.eventType === 'MEMBER_MESSAGE')}><summary>対応履歴 {item.events.length}件</summary><ol>{item.events.map(event => <li key={event.id}><strong>{eventLabels[event.eventType] ?? event.eventType}</strong> · {event.actor.displayName} · {date(event.occurredAt)} JST<div>{event.reason}</div>{event.publicMessage && <div>{event.eventType === 'MEMBER_MESSAGE' ? '追加内容' : '会員への回答'}：{event.publicMessage}</div>}</li>)}</ol></details>}
    <Notice value={error} error /><Notice value={notice} /><form className="support-triage" onSubmit={saveTriage}><div className="support-triage-grid"><label className="field">優先度<select value={priority} onChange={event => setPriority(event.target.value as Priority)}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="field">担当者<select value={assignedToId} onChange={event => setAssignedToId(event.target.value)}><option value="">未割当</option>{assignees.map(assignee => <option value={assignee.id} key={assignee.id}>{assignee.displayName}（{assignee.role === 'ADMIN' ? '管理者' : '運営担当'}）</option>)}</select></label><label className="field">対応期限<input type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)} /></label></div><label className="field">振り分け変更の理由<input value={triageReason} onChange={event => setTriageReason(event.target.value)} maxLength={2000} placeholder="例：開催日前の通知確認が必要なため" /></label><div className="review-actions"><button className="button secondary small" disabled={busy || !triageReason.trim()}>振り分けを保存</button></div></form>
    {item.status !== 'RESOLVED' ? <div className="support-response"><label className="field">内部の対応理由<input value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} placeholder="例：通知設定と配信履歴を確認" /></label><label className="field">会員への回答<textarea value={reply} onChange={event => setReply(event.target.value)} maxLength={2000} rows={3} placeholder="解決済みにする場合に、会員へ表示する回答を入力" /></label><div className="review-actions">{item.status === 'OPEN' && <button className="button secondary small" disabled={busy || !reason.trim()} onClick={() => void update('IN_PROGRESS')}>確認を開始</button>}<button className="button small" disabled={busy || !reason.trim() || !reply.trim()} onClick={() => void update('RESOLVED')}>回答して解決</button></div></div> : <div className="support-response"><label className="field">再開理由<input value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} placeholder="例：追加確認が必要になったため" /></label><button className="button secondary small" disabled={busy || !reason.trim()} onClick={() => void update('OPEN')}>問い合わせを再開</button></div>}</article>;
}

export function AdminSupport() {
  const [items, setItems] = useState<AdminItem[]>([]); const [assignees, setAssignees] = useState<Assignee[]>([]); const [status, setStatus] = useState<'ALL' | Status>('ALL'); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); try { const result = await request<{ items: AdminItem[]; assignees: Assignee[] }>(`admin/support?status=${status}`); setItems(result.items); setAssignees(result.assignees); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, [status]);
  useEffect(() => { void load(); }, [load]);
  return <><div className="page-heading"><span className="eyebrow">MEMBER SUPPORT</span><h1>お問い合わせ対応</h1><p>期限超過、優先度、対応期限の順に確認できます。担当者を決めてから回答してください。</p></div><Notice value={error} error /><section className="panel"><div className="panel-heading"><div><h2>受付一覧</h2><span className="count-tag">未解決 {items.filter(item => item.status !== 'RESOLVED').length}件</span></div><label className="compact-filter">状態<select value={status} onChange={event => setStatus(event.target.value as 'ALL' | Status)}><option value="ALL">すべて</option><option value="OPEN">受付済み</option><option value="IN_PROGRESS">確認中</option><option value="RESOLVED">回答済み</option></select></label></div>{loading ? <div className="panel-body" role="status">お問い合わせを読み込み中…</div> : !items.length ? <div className="panel-body"><p className="muted">該当するお問い合わせはありません。</p></div> : <div className="support-list admin-support-list">{items.map(item => <AdminSupportItem key={item.id} item={item} assignees={assignees} onUpdated={load} />)}</div>}</section></>;
}
