'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BellRing, Check, ChevronLeft, ChevronRight } from 'lucide-react';

type Item = { id: string; eventType: string; title: string; createdAt: string; publishedAt: string; version: number; visibility: string; readAt: string | null; href: string; race: { id: string; raceDate: string; venue: string; number: number; name: string; startsAt: string } | null; win5: { id: string; targetDate: string; title: string } | null };
type Data = { items: Item[]; total: number; unreadCount: number; page: number; limit: number };
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
async function api<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理に失敗しました。');
  return result;
}

export function MemberNotifications() {
  const router = useRouter(); const [data, setData] = useState<Data | null>(null); const [page, setPage] = useState(1); const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const load = useCallback(async () => { setError(''); try { setData(await api<Data>(`me/notifications?page=${page}&unread=${unread}`)); } catch (e) { setError((e as Error).message); } }, [page, unread]);
  useEffect(() => { void load(); }, [load]);
  async function open(item: Item) { setBusy(item.id); setError(''); try { if (!item.readAt) await api(`me/notifications/${item.id}/read`, 'POST'); router.push(item.href); } catch (e) { setError((e as Error).message); setBusy(''); } }
  return <><div className="page-heading"><span className="eyebrow">NOTIFICATIONS</span><h1>お知らせ</h1><p>対象レース、WIN5紙面、最終予想、確認済み評価結果の配信履歴を確認できます。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <section className="panel member-notifications"><div className="panel-heading notification-heading"><div><h2>配信履歴</h2><small>{data?.unreadCount ?? 0}件の未読</small></div><div className="notification-tabs" role="group" aria-label="お知らせの表示"><button className={!unread ? 'selected' : ''} aria-pressed={!unread} onClick={() => { setUnread(false); setPage(1); }}>すべて</button><button className={unread ? 'selected' : ''} aria-pressed={unread} onClick={() => { setUnread(true); setPage(1); }}>未読</button></div></div>
      {!data ? <div className="panel-body loading" role="status">お知らせを読み込み中…</div> : data.items.length === 0 ? <div className="empty"><BellRing size={32} strokeWidth={1.3} /><h3>{unread ? '未読のお知らせはありません' : 'お知らせはまだありません'}</h3><p>{unread ? 'すべて確認済みです。' : '対象レースの告知、予想公開、評価結果確定後に表示されます。'}</p></div> : <div className="member-notification-list">{data.items.map(item => <article className={`member-notification ${item.readAt ? 'read' : 'unread'}`} key={item.id}><span className="notification-dot" aria-label={item.readAt ? '既読' : '未読'}>{item.readAt ? <Check size={14} /> : null}</span><div className="member-notification-copy"><div><span className="eyebrow">{item.eventType.endsWith('EVALUATION_CONFIRMED') ? 'EVALUATION RESULT' : item.win5 ? 'WIN5 PAPER' : item.eventType === 'RACE_ANNOUNCED' ? 'RACE ANNOUNCEMENT' : item.eventType.startsWith('FREE_REPORT_') ? 'FREE PADDOCK REPORT' : item.visibility === 'PAID' ? 'MEMBERS ONLY' : 'PREDICTION'}</span>{!item.readAt && <span className="status-tag">新着</span>}</div><h3>{item.title}</h3><strong>{item.win5 ? item.win5.title : `${item.race!.venue} ${item.race!.number}R ${item.race!.name}`}</strong><small>{item.win5?.targetDate ?? item.race!.raceDate} · {formatDate(item.publishedAt)} JST · 第{item.version}版</small></div><button className="button secondary small" disabled={busy === item.id} onClick={() => void open(item)}>{busy === item.id ? '移動中…' : '詳細を見る'}<ChevronRight size={16} /></button></article>)}</div>}
      {data && data.total > data.limit && <div className="pagination"><span>{data.total}件中 {(page - 1) * data.limit + 1}〜{Math.min(page * data.limit, data.total)}件</span><button className="icon-button" aria-label="前のページ" disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft /></button><button className="icon-button" aria-label="次のページ" disabled={page * data.limit >= data.total} onClick={() => setPage(value => value + 1)}><ChevronRight /></button></div>}
    </section></>;
}
