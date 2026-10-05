'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, RefreshCw, ShieldCheck, UserRoundX } from 'lucide-react';
import type { AdminAccountClosuresResponse, AdminRetentionPolicyResponse, AdminRetentionPreviewResponse } from '@keiba/domain';

type Item = AdminAccountClosuresResponse['items'][number];
const reasons: Record<string, string> = { SERVICE_NO_LONGER_NEEDED: '利用しなくなった', PRICE: '料金', CONTENT: '内容', OTHER: 'その他' };
const scopeLabels: Record<string, string> = { EMAIL: 'メール', DISPLAY_NAME: '表示名', AUTH_IDENTITY: '認証ID', LINE_IDENTITY: 'LINE識別子', ACQUISITION_METADATA: '流入情報', NETWORK_IDENTIFIERS: 'IP・User-Agent' };
const previewStatusLabels: Record<string, string> = { ELIGIBLE: '期限到来', NOT_DUE: '保持期間中', POLICY_UNMAPPED: '方針未対応' };
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function AdminAccountClosures() {
  const [items, setItems] = useState<Item[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1);
  const [policy, setPolicy] = useState<AdminRetentionPolicyResponse | null>(null); const [preview, setPreview] = useState<AdminRetentionPreviewResponse | null>(null); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [recordsResponse, policyResponse, previewResponse] = await Promise.all([fetch(`/api/v1/admin/account-closures?page=${page}`, { cache: 'no-store' }), fetch('/api/v1/admin/account-closures/retention-policy', { cache: 'no-store' }), fetch(`/api/v1/admin/account-closures/retention-preview?page=${page}`, { cache: 'no-store' })]);
      const records = await recordsResponse.json() as AdminAccountClosuresResponse & { message?: string };
      const retention = await policyResponse.json() as AdminRetentionPolicyResponse & { message?: string };
      const retentionPreview = await previewResponse.json() as AdminRetentionPreviewResponse & { message?: string };
      if (!recordsResponse.ok) throw new Error(records.message ?? '退会記録を取得できませんでした。');
      if (!policyResponse.ok) throw new Error(retention.message ?? '保持方針を取得できませんでした。');
      if (!previewResponse.ok) throw new Error(retentionPreview.message ?? '匿名化対象を確認できませんでした。');
      setItems(records.items); setTotal(records.total); setPolicy(retention); setPreview(retentionPreview);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [page]);
  useEffect(() => { void load(); }, [load]);

  async function approvePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setSuccess('');
    const formElement = event.currentTarget; const form = new FormData(formElement);
    try {
      const response = await fetch('/api/v1/admin/account-closures/retention-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        version: form.get('version'), identityRetentionDays: Number(form.get('identityRetentionDays')), networkIdentifierRetentionDays: Number(form.get('networkIdentifierRetentionDays')),
        anonymizationScope: form.getAll('anonymizationScope'), reRegistrationHandling: form.get('reRegistrationHandling'), dataRequestHandling: form.get('dataRequestHandling'), legalReviewReference: form.get('legalReviewReference'), reason: form.get('reason')
      }) });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? '保持方針を記録できませんでした。');
      setSuccess('正式な保持方針を監査履歴へ記録しました。'); formElement.reset(); await load();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }

  return <>
    <div className="page-heading"><span className="eyebrow">ACCOUNT RETENTION</span><h1>退会・保持記録</h1><p>利用停止済み会員、正式な保持方針、匿名化期限の到来状況を確認します。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}{success && <div className="notice success" role="status">{success}</div>}
    <section className="closure-overview"><div><UserRoundX /><span>退会記録</span><strong>{total}<small>件</small></strong></div><div><Archive /><span>現在の保持方針</span><strong>{policy?.current?.version ?? '開発版'}</strong><small>{policy?.current ? `識別情報 ${policy.current.identityRetentionDays}日` : '正式期間は未決定'}</small></div><button className="button secondary small" disabled={loading} onClick={() => void load()}><RefreshCw size={16} />再読込</button></section>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">POLICY APPROVAL</span><h2>正式方針の記録</h2></div><ShieldCheck size={20} /></div><div className="panel-body">
      {policy?.current && <div className="notice">承認者：{policy.current.approvedBy.displayName}／{formatDate(policy.current.approvedAt)}。匿名化対象：{policy.current.anonymizationScope.map(value => scopeLabels[value]).join('、')}。この方針versionで期限到来：{policy.dryRun?.eligibleClosures ?? 0}件。方針未対応：{policy.unmappedClosures}件。自動匿名化は無効です。</div>}
      <form className="closure-form" onSubmit={approvePolicy}><div className="form-grid"><label className="field">方針version<input name="version" required maxLength={80} placeholder="privacy-2026-10" /></label><label className="field">識別情報の保持日数<input name="identityRetentionDays" type="number" required min={0} max={3650} /></label><label className="field">IP・User-Agentの保持日数<input name="networkIdentifierRetentionDays" type="number" required min={0} max={3650} /></label><label className="field">再登録時の扱い<select name="reRegistrationHandling" defaultValue="MANUAL_REVIEW"><option value="MANUAL_REVIEW">人による確認</option><option value="NEW_ACCOUNT">新規アカウント</option></select></label><label className="field">開示・削除請求の扱い<select name="dataRequestHandling" defaultValue="MANUAL_LEGAL_REVIEW"><option value="MANUAL_LEGAL_REVIEW">法務確認を含む個別対応</option><option value="MANUAL_SUPPORT">サポートで個別対応</option></select></label></div>
        <fieldset className="field"><legend>匿名化対象（1つ以上）</legend><div className="checkbox-grid">{Object.entries(scopeLabels).map(([value, label]) => <label key={value}><input type="checkbox" name="anonymizationScope" value={value} />{label}</label>)}</div></fieldset>
        <label className="field">法務・方針確認の参照<input name="legalReviewReference" required maxLength={500} placeholder="承認資料、チケット番号、文書URL等" /></label><label className="field">記録理由<textarea name="reason" required maxLength={500} /></label>
        <div className="notice">この操作は方針を追記記録し、以後の退会へversionを固定します。既存会員の匿名化・削除は実行しません。</div><button className="button primary" disabled={saving}>{saving ? '記録中…' : '正式方針を承認記録'}</button></form>
    </div></section>
    <section className="panel"><div className="panel-heading"><h2>匿名化対象プレビュー</h2><span className="count-tag">読み取り専用</span></div>{loading ? <div className="panel-body" role="status">読み込み中…</div> : preview?.items.length ? <div className="closure-list">{preview.items.map(item => <article key={item.closureId} className="closure-row"><div><strong>{item.user.displayName}</strong><small>{item.user.email ?? 'メール未設定'} · {item.policyVersion}</small></div><div><span>判定</span><strong>{previewStatusLabels[item.status]}</strong><small>{item.status === 'NOT_DUE' ? `あと${item.daysRemaining}日` : item.status === 'POLICY_UNMAPPED' ? '最新方針を遡及適用しません' : '実行には別承認が必要'}</small></div><div><span>対象項目</span><strong>{item.anonymizationScope.length ? item.anonymizationScope.map(value => scopeLabels[value]).join('、') : '未確定'}</strong><small>保持履歴：{item.preservedRecords.join('、')}</small></div><div><span>外部確認</span><strong>{item.externalActionsRequired.length ? item.externalActionsRequired.map(value => value === 'SUPABASE_AUTH_REVIEW' ? '認証基盤' : 'LINE').join('、') : 'なし'}</strong><small>{item.eligibleAt ? `期限 ${formatDate(item.eligibleAt)}` : '期限未確定'}</small></div></article>)}</div> : <div className="empty"><ShieldCheck size={32} /><h3>確認対象はありません</h3><p>退会記録が作成されると、方針versionごとの判定を表示します。</p></div>}<div className="panel-foot">この一覧は確認専用です。画面表示によって匿名化・削除・外部サービス操作は実行されません。</div></section>
    <section className="panel"><div className="panel-heading"><h2>処理済み一覧</h2><span className="count-tag">{total} 件</span></div>{loading ? <div className="panel-body" role="status">読み込み中…</div> : items.length ? <div className="closure-list">{items.map(item => <article key={item.id} className="closure-row"><div><strong>{item.user.displayName}</strong><small>{item.user.email ?? 'メール未設定'} · {item.user.registrationMethod}</small></div><div><span>退会理由</span><strong>{reasons[item.reasonCode] ?? item.reasonCode}</strong></div><div><span>利用停止（JST）</span><strong>{formatDate(item.accessRevokedAt)}</strong></div><div><span className={`status-tag ${item.status === 'CLOSED' ? '' : 'warning'}`}>{item.status === 'CLOSED' ? '停止済み' : '要確認'}</span><small>{item.retentionPolicyVersion}</small></div></article>)}</div> : <div className="empty"><UserRoundX size={32} /><h3>退会記録はありません</h3><p>会員本人が退会すると、こちらへ追記されます。</p></div>}<div className="pagination"><span>全{total}件 · {page}ページ</span><button className="button secondary small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>前へ</button><button className="button secondary small" disabled={page * 20 >= total} onClick={() => setPage(value => value + 1)}>次へ</button></div></section>
    <div className="notice">公開・評価、支払・契約、同意、監査の履歴は削除しません。期限到来件数は確認用であり、この画面から匿名化や物理削除は行いません。</div>
  </>;
}
