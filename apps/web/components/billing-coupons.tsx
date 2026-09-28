'use client';
import { useEffect, useState } from 'react';
import type { AdminBillingCouponsResponse } from '@keiba/domain';

type Coupon = AdminBillingCouponsResponse['items'][number];
const planLabels = { FOUNDER: '創設会員', STANDARD: '通常月額', DAY_PASS: '1日利用' } as const;
const money = (value: number) => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(value);
const date = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const localDateTime = (dateValue: Date) => {
  const local = new Date(dateValue.getTime() - dateValue.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '処理に失敗しました。');
  return result;
}

export function AdminBillingCoupons() {
  const now = new Date();
  const initialEnd = new Date(now.getTime() + 30 * 86400000);
  const [data, setData] = useState<AdminBillingCouponsResponse | null>(null);
  const [code, setCode] = useState(''); const [name, setName] = useState('');
  const [discountType, setDiscountType] = useState<'PERCENT' | 'FIXED_YEN'>('PERCENT'); const [discountValue, setDiscountValue] = useState(10);
  const [duration, setDuration] = useState<'ONCE' | 'FOREVER'>('ONCE');
  const [plans, setPlans] = useState<Array<keyof typeof planLabels>>(['STANDARD']);
  const [startsAt, setStartsAt] = useState(localDateTime(now)); const [endsAt, setEndsAt] = useState(localDateTime(initialEnd));
  const [maxRedemptions, setMaxRedemptions] = useState(''); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = () => request<AdminBillingCouponsResponse>('admin/billing/coupons').then(setData).catch(value => setError(value.message));
  useEffect(() => { void load(); }, []);
  const togglePlan = (plan: keyof typeof planLabels) => setPlans(current => current.includes(plan) ? current.filter(item => item !== plan) : [...current, plan]);
  async function create() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await request<AdminBillingCouponsResponse>('admin/billing/coupons', 'POST', {
        code, name, discountType, discountValue, duration, applicablePlanCodes: plans,
        startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(),
        maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null, reason
      });
      setData(result); setCode(''); setName(''); setReason(''); setMessage('クーポンを発行しました。');
    } catch (value) { setError((value as Error).message); } finally { setBusy(false); }
  }
  async function deactivate(coupon: Coupon) {
    setBusy(true); setError(''); setMessage('');
    try {
      if (!reason.trim()) throw new Error('停止理由を入力してください。');
      setData(await request<AdminBillingCouponsResponse>(`admin/billing/coupons/${coupon.id}/deactivate`, 'POST', { reason }));
      setReason(''); setMessage(`${coupon.name}を停止しました。開始済みの決済は元の条件を維持します。`);
    } catch (value) { setError((value as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">COUPONS</span><h2>クーポン発行・利用状況</h2></div><span className="count-tag">{data?.items.length ?? 0}件</span></div><div className="panel-body">
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <div className="notice">割引コードは1会員につき1回だけ利用できます。複数クーポンの併用はできません。発行後は条件を変更せず、必要な場合は停止して新しいコードを発行します。</div>
    <div className="race-form-grid"><label className="field">クーポンコード<input value={code} onChange={event => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32))} minLength={4} maxLength={32} placeholder="WELCOME10" /></label><label className="field">管理用名称<input value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="初回登録キャンペーン" /></label><label className="field">割引方法<select value={discountType} onChange={event => setDiscountType(event.target.value as 'PERCENT' | 'FIXED_YEN')}><option value="PERCENT">定率（%）</option><option value="FIXED_YEN">定額（円）</option></select></label><label className="field">割引値<input type="number" min={1} max={discountType === 'PERCENT' ? 100 : 1000000} value={discountValue} onChange={event => setDiscountValue(Number(event.target.value))} /></label><label className="field">月額割引の期間<select value={duration} onChange={event => setDuration(event.target.value as 'ONCE' | 'FOREVER')}><option value="ONCE">初回決済のみ</option><option value="FOREVER">契約中は継続</option></select></label><label className="field">全体の利用上限<input type="number" min={1} max={1000000} value={maxRedemptions} onChange={event => setMaxRedemptions(event.target.value)} placeholder="空欄は上限なし" /></label><label className="field">利用開始<input type="datetime-local" value={startsAt} onChange={event => setStartsAt(event.target.value)} /></label><label className="field">利用終了<input type="datetime-local" value={endsAt} onChange={event => setEndsAt(event.target.value)} /></label></div>
    <fieldset className="field"><legend>対象プラン</legend><div className="credential-actions">{Object.entries(planLabels).map(([value, label]) => <label key={value}><input type="checkbox" checked={plans.includes(value as keyof typeof planLabels)} onChange={() => togglePlan(value as keyof typeof planLabels)} />{label}</label>)}</div></fieldset>
    <label className="field">発行・停止理由<input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} placeholder="例：無料会員向け初回申込キャンペーン" /></label>
    <button className="button" disabled={busy || code.length < 4 || !name.trim() || !plans.length || !reason.trim() || !startsAt || !endsAt} onClick={() => void create()}>{busy ? '処理中…' : 'クーポンを発行'}</button>
  </div>{!data?.items.length ? <div className="panel-body"><p className="muted">発行済みクーポンはありません。</p></div> : <div className="table-scroll"><table><thead><tr><th>コード・名称</th><th>割引</th><th>対象</th><th>期間</th><th>利用状況</th><th>操作</th></tr></thead><tbody>{data.items.map(coupon => <tr key={coupon.id}><td><strong className="mono">{coupon.code}</strong><small className="cell-note">{coupon.name}</small></td><td>{coupon.discountType === 'PERCENT' ? `${coupon.discountValue}%` : money(coupon.discountValue)}<small className="cell-note">{coupon.duration === 'ONCE' ? '初回のみ' : '継続割引'}</small></td><td>{coupon.applicablePlanCodes.map(plan => planLabels[plan]).join('・')}</td><td>{date(coupon.startsAt)}〜<small className="cell-note">{date(coupon.endsAt)}</small></td><td>利用済み {coupon.redeemedCount}件<small className="cell-note">決済中 {coupon.reservedCount}件{coupon.maxRedemptions ? `・上限 ${coupon.maxRedemptions}件` : ''}</small></td><td>{coupon.active ? <button className="button danger small" disabled={busy || !reason.trim()} onClick={() => void deactivate(coupon)}>停止</button> : <span className="status-tag warning">停止済み</span>}</td></tr>)}</tbody></table></div>}</section>;
}
