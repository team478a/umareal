'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, FileText, Gift, Send, TicketCheck, Users } from 'lucide-react';
import type { MemberReferralBenefitProgramResponse, MemberReferralReward, MemberReferralRewardRedeemResponse, MemberReferralSummary, ReferralBenefitGrantRedeemResponse } from '@keiba/domain';

async function request<T>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理に失敗しました。');
  return result as T;
}
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const jstDay = (value: string) => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
const dateText = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(value));
const rewardLabel: Record<string, string> = { AVAILABLE: '未使用', REDEEMED: '使用済み', EXPIRED: '期限切れ', INVALIDATED: '無効' };
const typeLabel: Record<string, string> = { DAY_PASS: '1日利用券', MONTHLY_ACCESS: '期間限定の月額相当閲覧', LIMITED_CONTENT: '限定コンテンツ' };

export function ReferralDashboard({ onAccessChanged }: { onAccessChanged: () => Promise<void> }) {
  const [data, setData] = useState<MemberReferralSummary | null>(null);
  const [program, setProgram] = useState<MemberReferralBenefitProgramResponse | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState('');
  const [dates, setDates] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const [summary, benefitProgram] = await Promise.all([request<MemberReferralSummary>('me/referrals'), request<MemberReferralBenefitProgramResponse>('me/referral-benefit-program')]);
      setData(summary); setProgram(benefitProgram); setError('');
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const shareUrl = useMemo(() => data ? `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(data.referralUrl)}&text=${encodeURIComponent('ウマリアル無料会員登録開始！')}` : '#', [data]);
  async function copy(value: string, messageText: string) { try { await navigator.clipboard.writeText(value); setMessage(messageText); setError(''); } catch { setError('コピーできませんでした。長押ししてコピーしてください。'); } }
  async function redeemLegacy(event: FormEvent, reward: MemberReferralReward) {
    event.preventDefault(); const targetDate = dates[reward.id] ?? today(); setBusy(reward.id); setError(''); setMessage('');
    try { await request<MemberReferralRewardRedeemResponse>(`me/referral-rewards/${reward.id}/redeem`, 'POST', { targetDate }); setMessage(`${targetDate}の一日利用券を有効にしました。`); await Promise.all([load(), onAccessChanged()]); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  async function redeemGrant(event: FormEvent, grant: MemberReferralBenefitProgramResponse['grants'][number]) {
    event.preventDefault(); const targetDate = grant.rewardType === 'DAY_PASS' ? dates[grant.id] ?? today() : null; setBusy(grant.id); setError(''); setMessage('');
    try {
      const result = await request<ReferralBenefitGrantRedeemResponse>(`me/referral-benefit-grants/${grant.id}/redeem`, 'POST', { targetDate }, { 'Idempotency-Key': crypto.randomUUID() });
      setMessage(result.rewardType === 'DAY_PASS' ? `${targetDate}の一日利用券を有効にしました。` : `${dateText(result.endsAt)}までの閲覧を開始しました。`);
      await Promise.all([load(), onAccessChanged()]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  if (!data || !program) return <section className="panel referral-panel"><div className="panel-body" role="status">友達紹介の状況を読み込み中…</div>{error && <div className="notice error" role="alert">{error}</div>}</section>;
  const availableLegacy = data.rewards.filter(reward => reward.status === 'AVAILABLE'); const legacyHistory = data.rewards.filter(reward => reward.status !== 'AVAILABLE');
  const availableGrants = program.grants.filter(grant => grant.status === 'AVAILABLE'); const grantHistory = program.grants.filter(grant => grant.status !== 'AVAILABLE');
  const activeOffers = program.offers.filter(offer => offer.grantEnabled); const nextOffer = activeOffers.find(offer => offer.remaining > 0);
  const nextTotal = nextOffer?.requiredReferralCount ?? data.nextMilestone?.requiredReferralCount ?? activeOffers.at(-1)?.requiredReferralCount ?? data.milestones.at(-1)?.requiredReferralCount ?? Math.max(1, data.qualifiedCount);
  const nextText = nextOffer ? `あと${nextOffer.remaining}人で「${nextOffer.name}」` : data.nextMilestone ? `あと${data.nextMilestone.remaining}人で一日券プレゼント` : '公開中の特典をすべて達成済み';
  return <section className="panel referral-panel" aria-labelledby="referral-title">
    <div className="panel-heading"><div><span className="eyebrow">SHARE WITH FRIENDS</span><h2 id="referral-title">友達紹介</h2></div><Gift size={23} /></div>
    <div className="referral-hero"><div><span>現在の紹介成立</span><strong>{data.qualifiedCount}<small>人</small></strong></div><div><strong>{nextText}</strong><div className="referral-meter" aria-label={`${data.qualifiedCount} / ${nextTotal}`}><span style={{ width: `${Math.min(100, data.qualifiedCount / nextTotal * 100)}%` }} /></div><small>{data.qualifiedCount} / {nextTotal}</small></div></div>
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <div className="referral-share"><label>あなたの紹介URL<input readOnly value={data.referralUrl} onFocus={event => event.currentTarget.select()} /></label><label>紹介コード<input readOnly value={data.referralCode} onFocus={event => event.currentTarget.select()} /></label><div><a className="button" href={shareUrl} target="_blank" rel="noreferrer"><Send size={17} />LINEで紹介</a><button className="button secondary" type="button" onClick={() => void copy(data.referralUrl, '紹介URLをコピーしました。')}><Copy size={17} />紹介URLをコピー</button><button className="button secondary" type="button" onClick={() => void copy(data.referralCode, '紹介コードをコピーしました。')}><Copy size={17} />紹介コードをコピー</button></div></div>
    {program.offers.length > 0 && <div className="referral-milestones">{program.offers.map(offer => <article className={offer.achieved ? 'achieved' : ''} key={offer.versionId}><span>{offer.achieved ? <Check size={18} /> : <Users size={18} />}</span><div><strong>{offer.requiredReferralCount}人 · {offer.name}</strong><small>{typeLabel[offer.rewardType]}{offer.quantity > 1 ? ` ×${offer.quantity}` : ''}{offer.accessDays ? ` · ${offer.accessDays}日間` : ''}</small><small>{offer.description}</small></div><b>{offer.achieved ? '達成' : offer.grantEnabled ? `あと${offer.remaining}人` : '新規付与停止中'}</b></article>)}</div>}
    <div className="referral-milestones">{data.milestones.map(item => <article className={item.achieved ? 'achieved' : ''} key={item.id}><span>{item.achieved ? <Check size={18} /> : <Users size={18} />}</span><div><strong>{item.requiredReferralCount}人達成</strong><small>従来特典 · 一日券 ×{item.rewardQuantity}</small></div><b>{item.achieved ? '達成' : '未達成'}</b></article>)}</div>
    <div className="referral-rewards"><h3>獲得した紹介特典</h3>
      {availableGrants.map(grant => grant.rewardType === 'LIMITED_CONTENT' ? <article className="reward-card" key={grant.id}><FileText size={22} /><div><strong>{grant.benefit.name}</strong><small>{grant.memberGuidance} · 有効期限 {dateText(grant.expiresAt)}</small>{grant.contents.length ? <div className="panel-actions">{grant.contents.map(content => <Link className="button small" href={`/content/${content.id}`} key={content.id}>{content.title}</Link>)}</div> : <small>現在公開中の対象コンテンツはありません。</small>}</div></article> : <form className="reward-card" key={grant.id} onSubmit={event => void redeemGrant(event, grant)}><TicketCheck size={22} /><div><strong>{grant.benefit.name}</strong><small>{typeLabel[grant.rewardType]} · 有効期限 {dateText(grant.expiresAt)}</small><small>{grant.memberGuidance}</small></div>{grant.rewardType === 'DAY_PASS' && <label>利用日<input type="date" min={today()} max={jstDay(grant.expiresAt)} value={dates[grant.id] ?? today()} onChange={event => setDates({ ...dates, [grant.id]: event.target.value })} required /></label>}<button className="button small" disabled={busy === grant.id}>{busy === grant.id ? '処理中…' : grant.rewardType === 'MONTHLY_ACCESS' ? '閲覧を開始' : 'この日に使う'}</button></form>)}
      {availableLegacy.map(reward => <form className="reward-card" key={reward.id} onSubmit={event => void redeemLegacy(event, reward)}><TicketCheck size={22} /><div><strong>利用できる一日券</strong><small>従来の{reward.milestone.requiredReferralCount}人達成特典 · 有効期限 {dateText(reward.expiresAt)}</small></div><label>利用日<input type="date" min={today()} max={jstDay(reward.expiresAt)} value={dates[reward.id] ?? today()} onChange={event => setDates({ ...dates, [reward.id]: event.target.value })} required /></label><button className="button small" disabled={busy === reward.id}>{busy === reward.id ? '処理中…' : 'この日に使う'}</button></form>)}
      {!availableGrants.length && !availableLegacy.length && <p className="muted">現在利用できる紹介特典はありません。</p>}
      {(grantHistory.length > 0 || legacyHistory.length > 0) && <details><summary>使用済み・期限切れの特典（{grantHistory.length + legacyHistory.length}件）</summary><div className="reward-history">{grantHistory.map(grant => <div key={grant.id}><strong>{grant.benefit.name} · {rewardLabel[grant.status] ?? grant.status}</strong><span>{grant.usedAt ? `${dateText(grant.usedAt)}に使用` : `${dateText(grant.expiresAt)}まで`}</span></div>)}{legacyHistory.map(reward => <div key={reward.id}><strong>一日利用券 · {rewardLabel[reward.status] ?? reward.status}</strong><span>{reward.dayPass?.raceDate ?? `${dateText(reward.expiresAt)}まで`}</span></div>)}</div></details>}
    </div>
    <div className="panel-foot">紹介された方が無料登録と本人確認を完了すると成立します。特典の条件と期限は各カードで確認できます。</div>
  </section>;
}
