'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, ExternalLink, Image as ImageIcon, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { adminLineRichMenuResponseSchema, publishLineRichMenuResponseSchema, type AdminLineRichMenuResponse } from '@keiba/domain';

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/v1/admin/line-rich-menu${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? '処理に失敗しました。');
  return value;
}

const formatDate = (value: string | Date) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function AdminLineRichMenu() {
  const [data, setData] = useState<AdminLineRichMenuResponse | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [previewVersion, setPreviewVersion] = useState(0);
  const load = useCallback(async () => {
    setError('');
    try { setData(adminLineRichMenuResponseSchema.parse(await request(''))); }
    catch (cause) { setError((cause as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!data || !confirmed) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = publishLineRichMenuResponseSchema.parse(await request('/publish', 'POST', { currentPublicationId: data.currentPublication?.id ?? null, reason }));
      setMessage(result.transport === 'TEST_ONLY' ? '模擬公開が完了しました。実LINEには反映していません。' : 'LINEの標準リッチメニューを公開しました。');
      setReason(''); setConfirmed(false); await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  if (!data && !error) return <p role="status">LINEメニューを読み込み中…</p>;
  return <>
    <div className="page-heading"><span className="eyebrow">LINE EXPERIENCE</span><h1>LINEリッチメニュー</h1><p>会員がLINEから迷わず主要画面へ移動できるメニューを、確認してから公開します。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice" role="status">{message}</div>}
    {data && <div className="rich-menu-admin-grid">
      <section className="panel rich-menu-preview-panel" aria-labelledby="rich-menu-preview-title">
        <div className="panel-heading"><div><span className="eyebrow">PREVIEW</span><h2 id="rich-menu-preview-title">公開イメージ</h2></div><button className="button secondary small" type="button" onClick={() => setPreviewVersion(value => value + 1)}><RefreshCw size={15} />再表示</button></div>
        <div className="rich-menu-preview"><img src={`/api/v1/admin/line-rich-menu/preview?v=${previewVersion}`} alt="6つのボタンを配置したLINEリッチメニューのプレビュー" /></div>
        <div className="rich-menu-destinations">{data.menu.items.map(item => <a href={item.url} target="_blank" rel="noreferrer" key={item.key}><span><strong>{item.label}</strong><small>{item.description}</small></span><ExternalLink size={16} /></a>)}</div>
      </section>
      <section className="panel rich-menu-publish-panel" aria-labelledby="rich-menu-publish-title">
        <div className="panel-heading"><div><span className="eyebrow">PUBLISH</span><h2 id="rich-menu-publish-title">公開する</h2></div><span className={`status-tag ${data.transport === 'UNAVAILABLE' ? 'warning' : ''}`}>{data.transport === 'LINE' ? 'LINE接続' : data.transport === 'TEST_ONLY' ? '模擬公開' : '公開停止中'}</span></div>
        <div className="panel-body">
          {data.transport === 'TEST_ONLY' && <div className="rich-menu-mode"><ShieldCheck size={22} /><div><strong>安全な模擬公開です</strong><p>履歴と画面動作だけを確認し、LINE公式アカウントには反映しません。</p></div></div>}
          {data.transport === 'LINE' && !data.credentialsConfigured && <div className="notice error">Messaging APIのアクセストークンを連携設定に保存してください。</div>}
          {data.transport === 'UNAVAILABLE' && <div className="notice error">LINE通知transportが無効です。「サービス・連携設定」とサーバー環境変数を確認してください。</div>}
          <div className="rich-menu-current"><span>現在の公開記録</span>{data.currentPublication ? <><strong>{formatDate(data.currentPublication.completedAt!)}</strong><small>理由：{data.currentPublication.reason}</small></> : <strong>まだありません</strong>}</div>
          <form onSubmit={publish} className="rich-menu-publish-form">
            <label className="field">公開理由<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required rows={3} placeholder="例：初回公開。6つの移動先を確認済み" /></label>
            <label className="rich-menu-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span><strong>上の画像と6つの移動先を確認しました</strong><small>公開後に画像を直接差し替えることはできません。変更時は新しいメニューとして公開します。</small></span></label>
            <button className="button full" disabled={busy || !confirmed || !reason.trim() || data.transport === 'UNAVAILABLE' || (data.transport === 'LINE' && !data.credentialsConfigured)}>{busy ? '公開処理中…' : data.transport === 'TEST_ONLY' ? <><ImageIcon size={17} />模擬公開する</> : <><Send size={17} />LINEへ公開する</>}</button>
          </form>
        </div>
      </section>
    </div>}
    {data && <section className="panel rich-menu-history" aria-labelledby="rich-menu-history-title"><div className="panel-heading"><div><span className="eyebrow">HISTORY</span><h2 id="rich-menu-history-title">公開履歴</h2></div><span className="count-tag">直近{data.attempts.length}件</span></div>{data.attempts.length ? <div className="table-scroll"><table><thead><tr><th>状態</th><th>日時</th><th>理由</th><th>画像</th></tr></thead><tbody>{data.attempts.map(item => <tr key={item.id}><td><span className={`status-tag ${item.status === 'FAILED' ? 'warning' : ''}`}>{item.status === 'PUBLISHED' ? '公開済み' : item.status === 'PUBLISHING' ? '処理中' : '失敗'}</span></td><td>{formatDate(item.completedAt ?? item.createdAt)}</td><td>{item.reason}{item.errorCode && <small>エラー：{item.errorCode}</small>}</td><td className="mono"><Check size={14} /> {item.imageSha256.slice(0, 10)}…</td></tr>)}</tbody></table></div> : <div className="panel-body"><p>公開履歴はまだありません。</p></div>}</section>}
  </>;
}
