# Phase 3A 管理設定 実装報告

## 実装した動作

- `/admin/settings` でMessaging APIのChannel ID、Channel secret、Channel access tokenを登録・更新・明示削除
- LINE Loginの専用Channel ID、Channel secret、Callback URLを別設定として管理
- すべてのChannel secretとChannel access tokenをAES-256-GCMで暗号化保存し、API・画面・監査ログへ非返却
- 予想公開、CSV取込、LINE通知、LINE Login、新規購入の独立した運用スイッチ
- 予想公開とCSV取込は、プレビュー時と確定時に停止状態を再検証
- 通知の最大試行回数、初回待機秒数、運用メッセージの管理
- revisionによる管理設定の競合検出と、理由・実行者・時刻を含む監査記録
- 管理ダッシュボードに公開待ちレース、QUEUED通知、停止中機能の警告を追加
- ADMIN+AAL2だけが更新可能。OPERATORは秘密値を除く状態だけをAPIで確認可能

## 検証結果

- Prisma生成と8件のマイグレーション: 成功
- TypeScript型検査、ESLint、全アプリのプロダクションビルド: 成功
- ドメイン単体試験15件: 成功
- API/DB統合試験20件: 成功。秘密値暗号化・非返却、監査ログ非混入、AAL2、ロール、競合、DB制約、公開停止、CSV停止を含む
- Chromium E2E 14件: desktop/mobileとも成功。管理画面でのMessaging API・LINE Login資格情報と通知方針の保存を含む
- 本番環境でのローカル認証拒否: 成功

## 現在の境界

資格情報は保存できるが、LINEへの疎通確認、Webhook受付、OAuth callback、会員アカウント連携、通知送信・再試行・手動再送はまだ行わない。管理画面の接続状態は「未設定」または「設定済み・未疎通」だけを表示する。

次区間は、この設定を送信直前に読み、会員の通知設定と閲覧権限を再確認する通知ワーカー、送信履歴、失敗分類、再試行、手動再送である。外部LINE接続には実チャネル資格情報と公開Webhook URLが必要。
