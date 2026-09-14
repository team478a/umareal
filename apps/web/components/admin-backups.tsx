'use client';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, DatabaseBackup, RefreshCw, ShieldAlert } from 'lucide-react';

type Counts = { users: number; races: number; predictionVersions: number; auditLogs: number; notificationEvents: number };
type BackupStatus =
  | { status: 'VERIFIED'; verifiedAt: string; backupId: string; format: string; postgresMajor: number; encrypted: false; sha256: string; sizeBytes: number; fileCount: number; migrations: number; requiredTriggers: number; restoredDatabaseRemoved: true; counts: Counts }
  | { status: 'FAILED'; attemptedAt: string; errorCode: string; backupId: string | null; restoredDatabaseRemoved: boolean }
  | { status: 'NOT_RUN' | 'INVALID'; localOnly: true };

async function loadStatus(): Promise<BackupStatus> {
  const response = await fetch('/api/v1/admin/backups/status', { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '確認結果を取得できませんでした。');
  return result as BackupStatus;
}

const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
const formatBytes = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;

export function AdminBackups() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { setStatus(await loadStatus()); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const verified = status?.status === 'VERIFIED' ? status : null;
  const failed = status?.status === 'FAILED' ? status : null;
  return <>
    <div className="page-heading"><span className="eyebrow">DATA PROTECTION</span><h1>バックアップ・復元確認</h1><p>ローカルDBの物理バックアップを隔離環境へ復元し、データと保護設定を照合した結果です。</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
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
    <section className="panel"><div className="panel-heading"><h2>検証内容</h2></div><ol className="backup-checklist">
      <li><DatabaseBackup /><div><strong>停止中に物理コピー</strong><small>書込み途中のファイルを含めない状態で保存</small></div></li>
      <li><CheckCircle2 /><div><strong>ハッシュ照合</strong><small>バックアップと復元前コピーの全ファイルを照合</small></div></li>
      <li><CheckCircle2 /><div><strong>隔離ポートで起動</strong><small>元DBと異なるポート55433だけで復元確認</small></div></li>
      <li><CheckCircle2 /><div><strong>データ件数を比較</strong><small>主要5テーブルとマイグレーションを照合</small></div></li>
      <li><CheckCircle2 /><div><strong>不変化設定を確認</strong><small>予想公開版・印・買い目・操作履歴の保護トリガーを確認</small></div></li>
      <li><CheckCircle2 /><div><strong>一時データを削除</strong><small>復元検証用ディレクトリだけを停止後に消去</small></div></li>
    </ol><div className="panel-foot backup-command"><span>実行コマンド</span><code>pnpm db:backup:verify</code></div></section>
    <div className="notice">ローカル検証ファイルは暗号化されず、<code>.local/backups</code> に保存されます。本番では保存先の暗号化、世代管理、別拠点保管、RPO/RTOを運用基盤に合わせて決めます。管理画面からバックアップは実行できません。</div>
  </>;
}
