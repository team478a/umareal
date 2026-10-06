'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AdminAuditResponse } from '@keiba/domain';
import { Search, ShieldCheck } from 'lucide-react';

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? '操作履歴を取得できませんでした。');
  return value as T;
}

type Filters = { from: string; to: string; action: string; targetType: string; requestId: string };
const emptyFilters: Filters = { from: '', to: '', action: '', targetType: '', requestId: '' };

const actionLabels: Record<string, string> = {
  RACE_CREATE: 'レース登録', RACE_UPDATE: 'レース更新', MANUAL_ENTRY_CREATE: '出走馬登録',
  PREDICTION_PUBLISH: '予想公開', PREDICTION_CORRECT: '予想訂正', RESULT_CONFIRM: '結果確定',
  HORSE_IDENTITY_RESOLVE: '馬ID確認', HORSE_IDENTITY_CORRECT: '馬ID訂正', SETTINGS_UPDATE: '管理設定変更'
};

function jst(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}

export function AdminAudit() {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [data, setData] = useState<AdminAuditResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true); setError('');
    const query = new URLSearchParams({ page: String(page) });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    try { const value = await api<AdminAuditResponse>(`admin/audit?${query}`); if (sequence === requestSequence.current) setData(value); }
    catch (cause) { if (sequence === requestSequence.current) setError((cause as Error).message); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, [filters, page]);
  useEffect(() => { void load(); return () => { requestSequence.current++; }; }, [load]);
  function submit(event: FormEvent) { event.preventDefault(); setPage(1); setFilters({ ...draft }); }
  function reset() { setDraft(emptyFilters); setPage(1); setFilters(emptyFilters); }
  return <><div className="page-heading"><span className="eyebrow">AUDIT TRAIL</span><h1>操作履歴</h1><p>管理操作を期間、操作、対象、リクエストIDで確認します。</p></div>
    <section className="panel"><form className="audit-filters" onSubmit={submit}><div className="audit-filter-grid">
      <label className="field">開始日（JST）<input type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label className="field">終了日（JST）<input type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <label className="field">操作<input maxLength={100} placeholder="例：RACE または PUBLISH" value={draft.action} onChange={event => setDraft({ ...draft, action: event.target.value })} /></label>
      <label className="field">対象種別<input maxLength={100} placeholder="例：RACE" value={draft.targetType} onChange={event => setDraft({ ...draft, targetType: event.target.value })} /></label>
      <label className="field audit-request-filter">リクエストID<input maxLength={200} value={draft.requestId} onChange={event => setDraft({ ...draft, requestId: event.target.value })} /></label>
    </div><div className="form-actions"><button className="button" disabled={loading}><Search size={16} />絞り込む</button><button className="button secondary" type="button" disabled={loading} onClick={reset}>条件をクリア</button></div><p className="muted form-note">期間は最大93日です。リクエストIDは完全一致、操作と対象種別は部分一致で検索します。</p></form></section>
    {error && <div className="notice error" role="alert">{error}</div>}
    <section className="panel"><div className="panel-heading"><div><h2>記録一覧</h2><span className="count-tag">全{data?.total ?? 0}件</span></div><span className="audit-safe-note"><ShieldCheck size={16} />秘密情報・内部詳細は表示しません</span></div>
      {loading && !data ? <div className="panel-body" role="status">操作履歴を読み込み中…</div> : data?.items.length ? <div className="table-scroll"><table className="audit-table"><thead><tr><th>操作 / 対象</th><th>担当者</th><th>理由</th><th>日時（JST）</th><th>リクエストID</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td><strong>{actionLabels[item.action] ?? item.action}</strong><small>{item.action}<br />{item.targetType} · {item.targetId}</small></td><td>{item.actorDisplayName ?? 'システム'}<small>{item.actorRole ?? 'SYSTEM'}</small></td><td>{item.reason}</td><td>{jst(item.createdAt)}</td><td className="mono">{item.requestId}</td></tr>)}</tbody></table></div> : !loading && <div className="panel-body"><p className="muted">条件に一致する操作履歴はありません。</p></div>}
      <div className="pagination"><span>{data?.page ?? page}ページ</span><button className="button secondary small" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>前へ</button><button className="button secondary small" disabled={loading || !data || page * data.limit >= data.total} onClick={() => setPage(value => value + 1)}>次へ</button></div>
    </section></>;
}
