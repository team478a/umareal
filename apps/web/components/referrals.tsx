'use client';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, Gift, Send, TicketCheck, Users } from 'lucide-react';
import type { MemberReferralReward, MemberReferralSummary } from '@keiba/domain';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理に失敗しました。');
  return result as T;
}
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const jstDay = (value: string) => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
const dateText = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(value));
const rewardLabel: Record<string, string> = { AVAILABLE: '未使用', REDEEMED: '使用済み', EXPIRED: '期限切れ', INVALIDATED: '無効' };

export function ReferralDashboard({ onAccessChanged }: { onAccessChanged: () => Promise<void> }) {
  const [data, setData] = useState<MemberReferralSummary | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState('');
  const [dates, setDates] = useState<Record<string, string>>({});
  const load = useCallback(async () => { try { setData(await request<MemberReferralSummary>('me/referrals')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const shareUrl = useMemo(() => data ? `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(data.referralUrl)}&text=${encodeURIComponent('ウマリアルを紹介します。無料登録後、競馬の注目馬やレース見解を確認できます。')}` : '#', [data]);
  async function copy() { if (!data) return; try { await navigator.clipboard.writeText(data.referralUrl); setMessage('紹介URLをコピーしました。'); setError(''); } catch { setError('URLをコピーできませんでした。長押ししてコピーしてください。'); } }
  async function redeem(event: FormEvent, reward: MemberReferralReward) {
    event.preventDefault(); const targetDate = dates[reward.id] ?? today(); setBusy(reward.id); setError(''); setMessage('');
    try { await request(`me/referral-rewards/${reward.id}/redeem`, 'POST', { targetDate }); setMessage(`${targetDate}の一日利用券を有効にしました。`); await Promise.all([load(), onAccessChanged()]); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  if (!data) return <section className="panel referral-panel"><div className="panel-body" role="status">友達紹介の状況を読み込み中…</div>{error && <div className="notice error" role="alert">{error}</div>}</section>;
  const available = data.rewards.filter(reward => reward.status === 'AVAILABLE');
  const history = data.rewards.filter(reward => reward.status !== 'AVAILABLE');
  const nextTotal = data.nextMilestone?.requiredReferralCount ?? data.milestones.at(-1)?.requiredReferralCount ?? Math.max(1, data.qualifiedCount);
  return <section className="panel referral-panel" aria-labelledby="referral-title">
    <div className="panel-heading"><div><span className="eyebrow">SHARE WITH FRIENDS</span><h2 id="referral-title">友達紹介</h2></div><Gift size={23} /></div>
    <div className="referral-hero"><div><span>現在の紹介成立</span><strong>{data.qualifiedCount}<small>人</small></strong></div><div><strong>{data.nextMilestone ? `あと${data.nextMilestone.remaining}人で一日券プレゼント` : 'すべての特典を達成済み'}</strong><div className="referral-meter" aria-label={`${data.qualifiedCount} / ${nextTotal}`}><span style={{ width: `${Math.min(100, data.qualifiedCount / nextTotal * 100)}%` }} /></div><small>{data.qualifiedCount} / {nextTotal}</small></div></div>
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <div className="referral-share"><label>あなたの紹介URL<input readOnly value={data.referralUrl} onFocus={event => event.currentTarget.select()} /></label><div><a className="button" href={shareUrl} target="_blank" rel="noreferrer"><Send size={17} />LINEで紹介</a><button className="button secondary" type="button" onClick={() => void copy()}><Copy size={17} />紹介URLをコピー</button></div></div>
    <div className="referral-milestones">{data.milestones.map(item => <article className={item.achieved ? 'achieved' : ''} key={item.id}><span>{item.achieved ? <Check size={18} /> : <Users size={18} />}</span><div><strong>{item.requiredReferralCount}人達成</strong><small>一日券 ×{item.rewardQuantity}</small></div><b>{item.achieved ? '達成' : '未達成'}</b></article>)}</div>
    <div className="referral-rewards"><h3>獲得した紹介特典</h3>{available.length ? available.map(reward => <form className="reward-card" key={reward.id} onSubmit={event => void redeem(event, reward)}><TicketCheck size={22} /><div><strong>利用できる一日券</strong><small>{reward.milestone.requiredReferralCount}人達成特典 · 有効期限 {dateText(reward.expiresAt)}</small></div><label>利用日<input type="date" min={today()} max={jstDay(reward.expiresAt)} value={dates[reward.id] ?? today()} onChange={event => setDates({ ...dates, [reward.id]: event.target.value })} required /></label><button className="button small" disabled={busy === reward.id}>{busy === reward.id ? '処理中…' : 'この日に使う'}</button></form>) : <p className="muted">利用できる一日券はありません。</p>}
      {history.length > 0 && <details><summary>使用済み・期限切れの一日券（{history.length}枚）</summary><div className="reward-history">{history.map(reward => <div key={reward.id}><strong>{rewardLabel[reward.status] ?? reward.status}</strong><span>{reward.dayPass?.raceDate ?? `${dateText(reward.expiresAt)}まで`}</span></div>)}</div></details>}
    </div>
    <div className="panel-foot">紹介は、紹介された方が無料登録と本人確認を完了した時点で成立します。一日券は獲得後に利用日を選べます。</div>
  </section>;
}
