'use client';
import { useEffect, useState } from 'react';
import { Check, Copy, Download, Share2 } from 'lucide-react';

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? '処理できませんでした。');
  return value;
}

type ShareItem = {
  id: string;
  kind: 'PADDOCK' | 'WIN5';
  targetDate: string;
  title: string;
  status: string;
  resultVersion: number;
  predictionVersion: number;
  publishedAt: string;
  confirmedAt: string;
  path: string;
  shareable: boolean;
  headline: string;
  text: string | null;
  resultLines: string[];
  blockedReason: string | null;
};

const jst = (value: string) => new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

export function SocialShareManager() {
  const [items, setItems] = useState<ShareItem[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { api<{ items: ShareItem[] }>('admin/social-shares?limit=50').then(value => setItems(value.items)).catch(reason => setError(reason.message)); }, []);

  function content(item: ShareItem) {
    if (!item.text) return '';
    return `${item.text}\n${window.location.origin}${item.path}`;
  }

  async function copy(item: ShareItem) {
    try {
      await navigator.clipboard.writeText(content(item));
      setCopied(item.id);
      setMessage('共有文をコピーしました。投稿前に内容を確認してください。');
    } catch { setError('共有文をコピーできませんでした。ブラウザの権限を確認してください。'); }
  }

  async function share(item: ShareItem) {
    if (!navigator.share) { await copy(item); return; }
    try { await navigator.share({ title: item.headline, text: item.text ?? '', url: `${window.location.origin}${item.path}` }); }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError('共有画面を開けませんでした。'); }
  }

  function downloadImage(item: ShareItem) {
    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 630;
    const context = canvas.getContext('2d');
    if (!context) { setError('共有画像を生成できませんでした。'); return; }
    context.fillStyle = '#f7f3e8'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#174f3b'; context.fillRect(0, 0, canvas.width, 24);
    context.fillStyle = '#174f3b'; context.font = '700 42px sans-serif'; context.fillText('ウマリアル', 78, 92);
    context.fillStyle = '#64736c'; context.font = '600 24px sans-serif'; context.fillText(item.kind === 'WIN5' ? 'WIN5 PAPER RESULT' : 'PADDOCK RESULT', 80, 150);
    context.fillStyle = '#17382d'; context.font = '700 48px sans-serif';
    item.resultLines.forEach((line, index) => context.fillText(line, 80, 270 + index * 84));
    context.fillStyle = '#64736c'; context.font = '400 23px sans-serif'; context.fillText('公開時刻と全予想結果はウマリアルで確認できます。', 80, 510);
    context.fillText(`${window.location.origin}${item.path}`, 80, 555);
    context.fillStyle = '#174f3b'; context.fillRect(80, 590, 1040, 2);
    canvas.toBlob(blob => {
      if (!blob) { setError('共有画像を生成できませんでした。'); return; }
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `umareal-${item.kind.toLowerCase()}-${item.targetDate}.png`; link.click(); URL.revokeObjectURL(url);
      setMessage('共有画像を保存しました。投稿前に内容を確認してください。');
    }, 'image/png');
  }

  return <>
    <div className="page-heading"><span className="eyebrow">SOCIAL SHARE</span><h1>SNS共有候補</h1><p>確定した馬評価結果から、誤解を招かない共有文を生成します。投稿は内容を確認してから行ってください。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice" role="status">{message}</div>}
    {!items.length && !error ? <section className="panel"><div className="panel-body">共有できる確定結果はまだありません。</div></section> : items.map(item => <section className="panel" key={`${item.kind}-${item.id}`}>
      <div className="panel-heading"><div><span className="eyebrow">{item.kind === 'WIN5' ? 'WIN5 RESULT' : 'PADDOCK RESULT'}</span><h2>{item.title}</h2></div><span className="status-tag">結果版 {item.resultVersion}</span></div>
      <div className="panel-body">
        <p className="muted">対象日 {item.targetDate} · 予想公開版 {item.predictionVersion} · 結果確認 {jst(item.confirmedAt)} JST</p>
        {item.shareable && item.text ? <><div className="prediction-total"><span>共有見出し</span><strong>{item.headline}</strong></div><pre className="share-preview">{content(item)}</pre></> : <div className="notice error">{item.blockedReason}</div>}
      </div>
      {item.shareable && <div className="panel-actions"><button className="button secondary" onClick={() => void copy(item)}>{copied === item.id ? <Check size={17} /> : <Copy size={17} />}共有文をコピー</button><button className="button secondary" onClick={() => downloadImage(item)}><Download size={17} />共有画像を保存</button><button className="button" onClick={() => void share(item)}><Share2 size={17} />端末から共有</button></div>}
    </section>)}
  </>;
}
