'use client';
import { useCallback, useEffect, useState } from 'react';
import { Archive, RefreshCw, UserRoundX } from 'lucide-react';

type Item = { id: string; reasonCode: string; requestedAt: string; accessRevokedAt: string; retentionPolicyVersion: string; status: 'CLOSED' | 'REVIEW_REQUIRED'; user: { id: string; displayName: string; email: string | null; registrationMethod: string; disabledAt: string | null } };
const reasons: Record<string, string> = { SERVICE_NO_LONGER_NEEDED: '利用しなくなった', PRICE: '料金', CONTENT: '内容', OTHER: 'その他' };
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function AdminAccountClosures() {
  const [items, setItems] = useState<Item[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { const response = await fetch(`/api/v1/admin/account-closures?page=${page}`, { cache: 'no-store' }); const result = await response.json(); if (!response.ok) throw new Error(result.message ?? '退会記録を取得できませんでした。'); setItems(result.items); setTotal(result.total); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, [page]);
  useEffect(() => { void load(); }, [load]);
  return <><div className="page-heading"><span className="eyebrow">ACCOUNT RETENTION</span><h1>退会・保持記録</h1><p>利用停止済みの会員と、履歴保持方針を確認します。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <section className="closure-overview"><div><UserRoundX /><span>退会記録</span><strong>{total}<small>件</small></strong></div><div><Archive /><span>現在の保持方針</span><strong>開発版</strong><small>正式期間は未決定</small></div><button className="button secondary small" disabled={loading} onClick={() => void load()}><RefreshCw size={16} />再読込</button></section>
    <section className="panel"><div className="panel-heading"><h2>処理済み一覧</h2><span className="count-tag">{total} 件</span></div>{loading ? <div className="panel-body" role="status">読み込み中…</div> : items.length ? <div className="closure-list">{items.map(item => <article key={item.id} className="closure-row"><div><strong>{item.user.displayName}</strong><small>{item.user.email ?? 'メール未設定'} · {item.user.registrationMethod}</small></div><div><span>退会理由</span><strong>{reasons[item.reasonCode] ?? item.reasonCode}</strong></div><div><span>利用停止（JST）</span><strong>{formatDate(item.accessRevokedAt)}</strong></div><div><span className={`status-tag ${item.status === 'CLOSED' ? '' : 'warning'}`}>{item.status === 'CLOSED' ? '停止済み' : '要確認'}</span><small>{item.retentionPolicyVersion}</small></div></article>)}</div> : <div className="empty"><UserRoundX size={32} /><h3>退会記録はありません</h3><p>会員本人が退会すると、こちらへ追記されます。</p></div>}<div className="pagination"><span>全{total}件 · {page}ページ</span><button className="button secondary small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>前へ</button><button className="button secondary small" disabled={page * 20 >= total} onClick={() => setPage(value => value + 1)}>次へ</button></div></section>
    <div className="notice">公開・評価、支払・契約、同意、監査の履歴は削除していません。個人情報の匿名化時期と法定保存期間は、正式なプライバシーポリシーと事業基盤の決定後に定めます。</div>
  </>;
}
