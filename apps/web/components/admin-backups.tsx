'use client';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, ClipboardCheck, DatabaseBackup, RefreshCw, ShieldAlert } from 'lucide-react';
import type { AdminBackupStatusResponse, AdminLocalRestoreAttestationResponse, AdminProductionBackupAttestationResponse } from '@keiba/domain';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init, headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '確認結果を取得できませんでした。');
  return result as T;
}

const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
const formatBytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;

export function AdminBackups() {
  const [status, setStatus] = useState<AdminBackupStatusResponse | null>(null);
  const [attestation, setAttestation] = useState<AdminLocalRestoreAttestationResponse['latest']>(null);
  const [productionAttestation, setProductionAttestation] = useState<AdminProductionBackupAttestationResponse['latest']>(null);
  const [verificationJson, setVerificationJson] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingProduction, setSavingProduction] = useState(false);
  const [production, setProduction] = useState({
    provider: '', encryptedAtRest: false, separateFailureDomain: false, automatedBackups: false,
    retentionDays: '30', retentionGenerations: '14', rpoMinutes: '60', rtoMinutes: '240', responsibleRole: '',
    restoreTestedAt: '', nextReviewAt: '', evidenceReference: '', reason: ''
  });
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextStatus, nextAttestation, nextProductionAttestation] = await Promise.all([
        api<AdminBackupStatusResponse>('/api/v1/admin/backups/status'),
        api<AdminLocalRestoreAttestationResponse>('/api/v1/admin/readiness/local-restore-attestation'),
        api<AdminProductionBackupAttestationResponse>('/api/v1/admin/readiness/production-backup-attestation')
      ]);
      setStatus(nextStatus); setAttestation(nextAttestation.latest); setProductionAttestation(nextProductionAttestation.latest);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function saveAttestation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage('');
    let verification: unknown;
    try { verification = JSON.parse(verificationJson); } catch { setError('復元確認結果は正しいJSON形式で貼り付けてください。'); return; }
    setSaving(true);
    try {
      const result = await api<AdminLocalRestoreAttestationResponse>('/api/v1/admin/readiness/local-restore-attestation', { method: 'POST', body: JSON.stringify({ verification, reason }) });
      setAttestation(result.latest); setVerificationJson(''); setReason(''); setMessage('復元確認結果を監査履歴へ記録しました。');
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  async function saveProductionAttestation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage(''); setSavingProduction(true);
    try {
      const result = await api<AdminProductionBackupAttestationResponse>('/api/v1/admin/readiness/production-backup-attestation', {
        method: 'POST', body: JSON.stringify({
          ...production,
          retentionDays: Number(production.retentionDays), retentionGenerations: Number(production.retentionGenerations),
          rpoMinutes: Number(production.rpoMinutes), rtoMinutes: Number(production.rtoMinutes),
          restoreTestedAt: new Date(production.restoreTestedAt).toISOString(), nextReviewAt: new Date(production.nextReviewAt).toISOString()
        })
      });
      setProductionAttestation(result.latest); setProduction(current => ({ ...current, reason: '' })); setMessage('本番バックアップ運用の確認結果を監査履歴へ記録しました。');
    } catch (e) { setError((e as Error).message); } finally { setSavingProduction(false); }
  }
  const verified = status?.status === 'VERIFIED' ? status : null;
  const failed = status?.status === 'FAILED' ? status : null;
  const productionReady = production.provider.trim() && production.responsibleRole.trim() && production.restoreTestedAt && production.nextReviewAt && production.evidenceReference.trim() && production.reason.trim() && production.encryptedAtRest && production.separateFailureDomain && production.automatedBackups;
  return <>
    <div className="page-heading"><span className="eyebrow">DATA PROTECTION</span><h1>バックアップ・復元確認</h1><p>ローカルDBの物理バックアップを隔離環境へ復元し、データと保護設定を照合した結果です。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    <section className={`panel backup-hero ${verified ? 'verified' : failed ? 'failed' : ''}`} aria-label="バックアップ検証結果">
      <div className="backup-state-icon">{verified ? <CheckCircle2 /> : <ShieldAlert />}</div>
      <div><span className="eyebrow">LATEST VERIFICATION</span><h2>{verified ? '復元確認済み' : failed ? '復元確認に失敗' : loading ? '確認結果を読み込み中' : '復元確認は未実施'}</h2><p>{verified ? `${formatDate(verified.verifiedAt)} JST に隔離復元と整合性確認を完了しました。` : failed ? `${formatDate(failed.attemptedAt)} JST の検証を完了できませんでした。` : '開発端末で検証コマンドを実行すると、ここに結果が表示されます。'}</p></div>
      <button className="button secondary small" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} />再読込</button>
    </section>
    {verified && <>
      <section className="backup-metrics" aria-label="バックアップ検証指標">
        <div><span>バックアップ容量</span><strong>{formatBytes(verified.sizeBytes)}</strong><small>{verified.fileCount}ファイル</small></div>
        <div><span>マイグレーション</span><strong>{verified.migrations}</strong><small>適用済み</small></div>
        <div><span>保護トリガー</span><strong>{verified.requiredTriggers}</strong><small>復元済み</small></div>
        <div><span>一時DB</span><strong>削除済み</strong><small>検証後に消去</small></div>
      </section>
      <section className="panel"><div className="panel-heading"><h2>整合性の照合</h2><span className="status-tag">一致</span></div><div className="backup-counts">
        {[['会員', verified.counts.users], ['レース', verified.counts.races], ['予想公開版', verified.counts.predictionVersions], ['操作履歴', verified.counts.auditLogs], ['通知イベント', verified.counts.notificationEvents]].map(([label, count]) => <div key={label}><span>{label}</span><strong>{count}</strong><small>件</small></div>)}
      </div></section>
      <section className="panel"><div className="panel-heading"><h2>バックアップ識別情報</h2></div><dl className="backup-details"><div><dt>ID</dt><dd className="mono">{verified.backupId}</dd></div><div><dt>形式</dt><dd>PostgreSQL {verified.postgresMajor} 物理ディレクトリ</dd></div><div><dt>SHA-256</dt><dd className="mono hash-value">{verified.sha256}</dd></div><div><dt>暗号化</dt><dd><span className="status-tag warning">ローカルでは未暗号化</span></dd></div></dl></section>
    </>}
    {failed && <div className="notice error" role="alert">検証コード: {failed.errorCode}。元のローカルDBは復元対象にしていません。端末のログを確認して再実行してください。</div>}
    <section className="panel restore-attestation" aria-label="ローカル復元確認の管理者記録">
      <div className="panel-heading"><div><span className="eyebrow">AUDITED ATTESTATION</span><h2>開発端末の復元結果を記録</h2></div><ClipboardCheck /></div>
      <p className="panel-intro">開発端末で <code>pnpm db:backup:verify</code> を実行し、生成された <code>.local/backups/status.json</code> の内容を貼り付けます。これは管理者による監査付き記録であり、本番サーバーでの自動検証ではありません。</p>
      {attestation && <div className="restore-attestation-latest">
        <strong>最新の管理者記録</strong>
        <span>{formatDate(attestation.recordedAt)} JST・{attestation.recordedBy.displayName}</span>
        <small>{attestation.verification.migrations} migrations / {attestation.verification.requiredTriggers} triggers・復元確認 {formatDate(attestation.verification.verifiedAt)} JST</small>
        <small>理由: {attestation.reason}</small>
      </div>}
      <form onSubmit={saveAttestation} className="restore-attestation-form">
        <label className="field"><span>復元確認結果（JSON）</span><textarea value={verificationJson} onChange={event => setVerificationJson(event.target.value)} rows={9} required placeholder={'{\n  "status": "VERIFIED",\n  ...\n}'} /></label>
        <label className="field"><span>記録理由</span><input value={reason} onChange={event => setReason(event.target.value)} required maxLength={500} placeholder="公開前の復元確認を実施したため" /></label>
        <button className="button primary" type="submit" disabled={saving || !verificationJson.trim() || !reason.trim()}>{saving ? '記録中…' : '監査履歴へ記録'}</button>
      </form>
    </section>
    <section className="panel restore-attestation" aria-label="本番バックアップ運用の管理者記録">
      <div className="panel-heading"><div><span className="eyebrow">PRODUCTION BACKUP</span><h2>本番バックアップ運用を記録</h2></div><DatabaseBackup /></div>
      <p className="panel-intro">外部基盤の設定を管理者が確認し、秘密値を含まない証跡番号と運用条件だけを監査履歴へ記録します。この記録だけで外部基盤を自動検証した扱いにはなりません。</p>
      {productionAttestation && <div className="restore-attestation-latest">
        <strong>{productionAttestation.reviewStatus === 'CURRENT' ? '最新の運用確認' : '確認期限切れ'}</strong>
        <span>{formatDate(productionAttestation.recordedAt)} JST・{productionAttestation.recordedBy.displayName}</span>
        <small>{productionAttestation.provider}・保持 {productionAttestation.retentionDays}日/{productionAttestation.retentionGenerations}世代・RPO {productionAttestation.rpoMinutes}分 / RTO {productionAttestation.rtoMinutes}分</small>
        <small>責任区分: {productionAttestation.responsibleRole}・証跡: {productionAttestation.evidenceReference}</small>
        <small>復元試験: {formatDate(productionAttestation.restoreTestedAt)} JST・次回確認: {formatDate(productionAttestation.nextReviewAt)} JST</small>
      </div>}
      <form onSubmit={saveProductionAttestation} className="restore-attestation-form">
        <label className="field"><span>バックアップ提供元</span><input value={production.provider} onChange={event => setProduction({ ...production, provider: event.target.value })} required maxLength={100} placeholder="Managed PostgreSQL" /></label>
        <div className="form-grid two">
          <label className="field"><span>保持日数</span><input type="number" min="1" max="3650" value={production.retentionDays} onChange={event => setProduction({ ...production, retentionDays: event.target.value })} required /></label>
          <label className="field"><span>保持世代数</span><input type="number" min="2" max="1000" value={production.retentionGenerations} onChange={event => setProduction({ ...production, retentionGenerations: event.target.value })} required /></label>
          <label className="field"><span>RPO（分）</span><input type="number" min="1" max="10080" value={production.rpoMinutes} onChange={event => setProduction({ ...production, rpoMinutes: event.target.value })} required /></label>
          <label className="field"><span>RTO（分）</span><input type="number" min="1" max="10080" value={production.rtoMinutes} onChange={event => setProduction({ ...production, rtoMinutes: event.target.value })} required /></label>
          <label className="field"><span>運用責任区分</span><input value={production.responsibleRole} onChange={event => setProduction({ ...production, responsibleRole: event.target.value })} required maxLength={100} placeholder="運用責任者" /></label>
          <label className="field"><span>証跡参照番号</span><input value={production.evidenceReference} onChange={event => setProduction({ ...production, evidenceReference: event.target.value })} required maxLength={100} pattern="[A-Za-z0-9][A-Za-z0-9._/-]*" placeholder="ops/backup-review-20261006" /></label>
          <label className="field"><span>最終復元試験</span><input type="datetime-local" value={production.restoreTestedAt} onChange={event => setProduction({ ...production, restoreTestedAt: event.target.value })} required /></label>
          <label className="field"><span>次回確認期限</span><input type="datetime-local" value={production.nextReviewAt} onChange={event => setProduction({ ...production, nextReviewAt: event.target.value })} required /></label>
        </div>
        <div className="checkbox-list">
          <label><input type="checkbox" checked={production.encryptedAtRest} onChange={event => setProduction({ ...production, encryptedAtRest: event.target.checked })} required />保存時の暗号化を確認</label>
          <label><input type="checkbox" checked={production.separateFailureDomain} onChange={event => setProduction({ ...production, separateFailureDomain: event.target.checked })} required />別障害領域への保管を確認</label>
          <label><input type="checkbox" checked={production.automatedBackups} onChange={event => setProduction({ ...production, automatedBackups: event.target.checked })} required />自動バックアップを確認</label>
        </div>
        <label className="field"><span>運用確認の記録理由</span><input value={production.reason} onChange={event => setProduction({ ...production, reason: event.target.value })} required maxLength={500} placeholder="本番公開前のバックアップ運用を確認したため" /></label>
        <button className="button primary" type="submit" disabled={savingProduction || !productionReady}>{savingProduction ? '記録中…' : '運用確認を記録'}</button>
      </form>
    </section>
    <section className="panel"><div className="panel-heading"><h2>検証内容</h2></div><ol className="backup-checklist">
      <li><DatabaseBackup /><div><strong>停止中に物理コピー</strong><small>書込み途中のファイルを含めない状態で保存</small></div></li>
      <li><CheckCircle2 /><div><strong>ハッシュ照合</strong><small>バックアップと復元前コピーの全ファイルを照合</small></div></li>
      <li><CheckCircle2 /><div><strong>隔離ポートで起動</strong><small>元DBと異なるポート55433だけで復元確認</small></div></li>
      <li><CheckCircle2 /><div><strong>データ件数を比較</strong><small>主要5テーブルとマイグレーションを照合</small></div></li>
        <li><CheckCircle2 /><div><strong>不変化設定を確認</strong><small>予想公開版・凍結評価・休止中の旧履歴・操作履歴の保護トリガーを確認</small></div></li>
      <li><CheckCircle2 /><div><strong>一時データを削除</strong><small>復元検証用ディレクトリだけを停止後に消去</small></div></li>
    </ol><div className="panel-foot backup-command"><span>実行コマンド</span><code>pnpm db:backup:verify</code></div></section>
    <div className="notice">ローカル検証ファイルは暗号化されず、<code>.local/backups</code> に保存されます。本番では保存先の暗号化、世代管理、別拠点保管、RPO/RTOを運用基盤に合わせて決めます。管理画面からバックアップは実行できません。</div>
  </>;
}
