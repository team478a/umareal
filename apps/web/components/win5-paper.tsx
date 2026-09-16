'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, CalendarDays, Clock3, Crown, LockKeyhole } from 'lucide-react';

type RaceMeta = { id: string; venue: string; number: number; startsAt: string; status: string };
type Product = { id: string; type: string; targetDate: string; title: string; status: string; scheduledPublishAt: string; publishedAt: string | null; confidence: string | null; races: { legNumber: number; race: RaceMeta }[]; latestVersion: VersionMeta | null };
type VersionMeta = { id: string; version: number; status: string; publishedAt: string; previousVersionId: string | null; correctionReason?: string | null };
type Evaluation = { entryId: string; horseId: string; number: number; horseName: string; status: string; evaluationType: 'PRIMARY' | 'SECONDARY' | 'WATCH' | 'RISK'; reason: string; displayOrder: number };
type Paper = { product: { expertName: string; confidence: string; summary: string }; races: { legNumber: number; confidence: string; paceView: string; shortComment: string; race: RaceMeta & { raceDate: string; name: string }; evaluations: Evaluation[] }[] };
type Detail = { access: 'FULL' | 'METADATA'; product: Product; version: (VersionMeta & { confidence: string; formatVersion: string; contentSnapshot: Paper; deadlineAt: string; correctionReason: string | null }) | null; versions: VersionMeta[]; locked: boolean };

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'WIN5情報を読み込めませんでした。');
  return result as T;
}
const jstDate = (date = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const dateTime = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const statusLabel = (product: Product) => product.latestVersion ? (product.latestVersion.status === 'CORRECTED' ? `訂正版 v${product.latestVersion.version}` : `公開済み v${product.latestVersion.version}`) : '公開予定';

function ProductCard({ product, label }: { product: Product; label?: string }) {
  const upcoming = product.races.filter(item => new Date(item.race.startsAt) > new Date()).sort((a, b) => +new Date(a.race.startsAt) - +new Date(b.race.startsAt))[0];
  return <article className="win5-product-card">
    <div className="win5-product-top"><div><span className="eyebrow">{label ?? product.targetDate}</span><h3>{product.title}</h3></div><span className={`status-tag ${product.latestVersion ? '' : 'warning'}`}>{statusLabel(product)}</span></div>
    <div className="win5-product-meta"><span><CalendarDays size={16} />対象日 {product.targetDate}</span><span><Clock3 size={16} />{product.latestVersion ? `公開 ${dateTime(product.latestVersion.publishedAt)} JST` : `予定 ${dateTime(product.scheduledPublishAt)} JST`}</span>{product.confidence && <span><Crown size={16} />全体信頼度 {product.confidence}</span>}</div>
    <div className="win5-leg-strip" aria-label="対象5レース">{product.races.map(item => <span key={item.legNumber}><b>{item.legNumber}</b>{item.race.venue} {item.race.number}R</span>)}</div>
    {upcoming && <p className="win5-next">次の対象レース：{upcoming.race.venue} {upcoming.race.number}R・{dateTime(upcoming.race.startsAt)} JST</p>}
    <Link className="button secondary" href={`/win5/${product.id}`}>紙面を確認 <ArrowRight size={16} /></Link>
  </article>;
}

export function Win5HomePanel() {
  const [items, setItems] = useState<Product[]>([]); const [error, setError] = useState('');
  useEffect(() => {
    const today = jstDate(); const tomorrow = jstDate(new Date(Date.now() + 86400000));
    Promise.all([request<{ items: Product[] }>(`win5?targetDate=${today}`), request<{ items: Product[] }>(`win5?targetDate=${tomorrow}`)])
      .then(([todayData, tomorrowData]) => setItems([...todayData.items, ...tomorrowData.items])).catch(e => setError((e as Error).message));
  }, []);
  if (error) return <div className="notice error" role="alert">{error}</div>;
  if (!items.length) return null;
  const today = jstDate();
  return <section className="panel win5-home"><div className="panel-heading"><div><span className="eyebrow">WIN5 PAPER</span><h2>WIN5紙面予想</h2></div><Link className="text-link" href="/win5">一覧を見る <ArrowRight size={16} /></Link></div><div className="win5-product-grid">{items.map(product => <ProductCard key={product.id} product={product} label={product.targetDate === today ? '本日のWIN5紙面予想' : '明日のWIN5紙面予想'} />)}</div></section>;
}

export function Win5Archive() {
  const [items, setItems] = useState<Product[]>([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  useEffect(() => { request<{ items: Product[] }>('win5').then(value => setItems(value.items)).catch(e => setError((e as Error).message)).finally(() => setLoading(false)); }, []);
  return <><div className="page-heading"><span className="eyebrow">WIN5 PAPER</span><h1>WIN5紙面予想</h1><p>前日に公開する5レースの紙面予想と、公開版の履歴を確認できます。</p></div>{error && <div className="notice error">{error}</div>}{loading ? <div className="loading" role="status">WIN5情報を読み込み中…</div> : items.length ? <div className="win5-product-grid archive">{items.map(product => <ProductCard key={product.id} product={product} />)}</div> : <div className="empty"><CalendarDays size={32} /><h3>WIN5紙面はまだありません</h3><p>公開予定が決まると、こちらに表示されます。</p></div>}</>;
}

export function Win5Paper({ productId, loggedIn }: { productId: string; loggedIn: boolean }) {
  const search = useSearchParams(); const selectedVersion = search.get('version');
  const [detail, setDetail] = useState<Detail | null>(null); const [error, setError] = useState('');
  useEffect(() => { setDetail(null); setError(''); request<Detail>(`win5/${productId}${selectedVersion ? `?version=${selectedVersion}` : ''}`).then(setDetail).catch(e => setError((e as Error).message)); }, [productId, selectedVersion]);
  if (error) return <><div className="page-heading"><span className="eyebrow">WIN5 PAPER</span><h1>WIN5紙面予想</h1></div><div className="notice error">{error}</div></>;
  if (!detail) return <div className="loading" role="status">WIN5紙面を読み込み中…</div>;
  const { product, version } = detail;
  return <><div className="page-heading"><span className="eyebrow">WIN5 PAPER · {product.targetDate}</span><h1>{product.title}</h1><p>{version ? `${version.status === 'CORRECTED' ? '訂正版' : '初版'} v${version.version}・${dateTime(version.publishedAt)} JST 公開` : `${dateTime(product.scheduledPublishAt)} JST 公開予定`}</p></div>
    <section className="panel win5-metadata"><div className="panel-heading"><div><span className="eyebrow">FIVE LEGS</span><h2>対象5レース</h2></div>{product.confidence && <span className="confidence-badge">信頼度 {product.confidence}</span>}</div><div className="win5-meta-legs">{product.races.map(item => <div key={item.legNumber}><b>第{item.legNumber}レース</b><strong>{item.race.venue} {item.race.number}R</strong><small>{dateTime(item.race.startsAt)} JST</small></div>)}</div></section>
    {detail.locked && <section className="panel win5-lock"><LockKeyhole size={30} /><div><h2>評価馬と詳しいレース見解は有料会員向けです</h2><p>月額会員または対象日の1日利用で、公開済み紙面の本文と訂正履歴を確認できます。</p></div><Link className="button" href={loggedIn ? `/plans?date=${product.targetDate}` : `/login?next=/win5/${product.id}`}>{loggedIn ? '閲覧プランを確認' : 'ログイン'}<ArrowRight size={16} /></Link></section>}
    {!version && !detail.locked && <section className="panel"><div className="panel-body"><p>紙面はまだ公開されていません。公開予定時刻になるまでお待ちください。</p></div></section>}
    {version && <PaperBody version={version} />}
    {detail.versions.length > 0 && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">VERSION HISTORY</span><h2>公開履歴</h2></div></div><div className="win5-history">{detail.versions.map(item => <Link key={item.id} className={`win5-history-row ${version?.version === item.version ? 'current' : ''}`} href={`/win5/${product.id}?version=${item.version}`}><span>v{item.version}・{item.status === 'CORRECTED' ? '訂正' : '初版'}</span><small>{dateTime(item.publishedAt)} JST{item.correctionReason ? `・${item.correctionReason}` : ''}</small></Link>)}</div></section>}
  </>;
}

function PaperBody({ version }: { version: NonNullable<Detail['version']> }) {
  const paper = version.contentSnapshot;
  const labels = { PRIMARY: '中心馬', SECONDARY: '相手候補', WATCH: '注目馬', RISK: '危険馬' } as const;
  return <section className="win5-paper-sheet"><header><div><span>WIN5 PREVIEW</span><h2>{paper.product.expertName}の5レース紙面</h2></div><div><small>全体信頼度</small><strong>{paper.product.confidence}</strong></div></header><div className="win5-paper-legs">{paper.races.map(leg => <article key={leg.legNumber}><div className="win5-paper-race"><b>第{leg.legNumber}対象レース</b><div><strong>{leg.race.venue} {leg.race.number}R · {leg.race.name}</strong><small>{dateTime(leg.race.startsAt)} JST</small></div><span>信頼度 {leg.confidence}</span></div><div className="win5-selections">{leg.evaluations.map(horse => <div className={horse.evaluationType === 'PRIMARY' ? 'center' : ''} key={horse.entryId}><span>{labels[horse.evaluationType]}</span><b>{horse.number}</b><strong>{horse.horseName}</strong>{horse.reason && <small>{horse.reason}</small>}</div>)}</div><div className="win5-comment"><span>展開見解</span><p>{leg.paceView}</p><span>レース短評</span><p>{leg.shortComment}</p></div></article>)}</div><footer><div className="win5-summary"><span>WIN5全体の総評</span><p>{paper.product.summary}</p></div><p>公開時刻：{dateTime(version.publishedAt)} JST</p><p>訂正：{version.correctionReason ? `あり（${version.correctionReason}）` : 'なし'}</p><small>本予想は、中心馬、相手候補、レース見解を提供するものです。<br />具体的な組み合わせや購入金額は指定していません。<br />馬券を購入する場合は、ご自身の判断と責任で行ってください。</small></footer></section>;
}
