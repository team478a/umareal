# Phase 0 と Phase 1 基盤の実装結果（履歴）

2026年9月12日。新規リポジトリに、ローカルで動作する会員・認証・権限制御の基盤を実装しました。MVP全体や本番運用の完了ではありません。

この文書はPhase 1完了時点の検証記録です。現在の到達点はPhase 6Pで、最新の機能と検証手順はREADME、各PHASE文書、DECISIONS.mdを参照してください。

## 実装した内容

- pnpm workspace、Next.js Web、NestJS API、PostgreSQL/Prisma、ワーカーの実行境界、共通ドメイン・設定。
- 会員登録、ログイン、ログアウト、同意履歴、通知設定、ローカル配信によるパスワード再設定。
- ランダムセッション、ハッシュ保存、HttpOnly cookie、Origin検証、レート制限、共通エラーとrequestId。
- TOTP登録・確認、秘密キー暗号化、使用済みコードの拒否、確認後のセッション回転。
- サーバー上のロールと担当レース制御。管理者と専門家はAAL2が必要。
- 有限期間の閲覧権限モデル、JSTの1日利用判定、管理者の手動付与APIと冪等キー。
- 監査ログの記録とDBトリガーによるUPDATE/DELETE/TRUNCATE拒否。
- 会員ホーム、マイページ、通知設定、同意履歴、セキュリティ、専門家一覧、管理ダッシュボード、会員一覧、操作履歴。
- SupabaseのJWT署名・issuer・audience・期限検証アダプター。実サービス接続は未実施。

## 主なファイル

| 対象 | ファイル |
| --- | --- |
| 仕様と設計 | AGENTS.md、docs/SPEC.md、DECISIONS.md、ERD.md、SCREENS.md |
| 起動と運用 | README.md、docs/OPERATIONS.md、.env.example、docker-compose.yml、scripts/ |
| APIと認証 | apps/api/src/main.ts、auth.service.ts、auth.controller.ts、app.controller.ts、security.ts |
| 画面とAPI中継 | apps/web/components/media-app.tsx、apps/web/app/globals.css、apps/web/app/api/v1/[...path]/route.ts |
| DB | packages/db/prisma/schema.prisma、3件のSQLマイグレーション、src/seed.ts |
| 共通ルール | packages/domain/src/index.ts |
| 検証 | packages/domain/src/access.test.ts、tests/auth.integration.test.ts、tests/e2e/ |
| CI | .github/workflows/ci.yml |

## 確認方法と結果

ローカルのPostgreSQL 16.14と、ビルド済みのWeb/APIを使用しました。Dockerが応答せず、当初予定したポートもWindowsの予約範囲だったため、作業フォルダ内の開発用PostgreSQLを127.0.0.1:55432で起動しました。環境の切り替えによってテストを省略していません。

| 確認 | 結果 |
| --- | --- |
| Prisma生成・3件のマイグレーション | 成功 |
| typecheck | 全パッケージ成功 |
| lint | エラー・警告なし |
| 単体テスト | 3件成功。ロール・MFA・担当・同意・JST境界・有効期間・未公開/無料権限を検証 |
| API/DB結合テスト | 5件成功。登録・同意・設定、ログアウト/再設定失効、MFA、担当制御、冪等権限付与、監査のDB保護を検証 |
| Playwright E2E | 6件成功。デスクトップ/モバイル各3件。会員操作、ナビゲーション、管理者MFAを検証 |
| build | 全パッケージ成功。最終変更したAPI/Webも再ビルド成功 |
| 本番起動ガード | ビルド済みAPIがlocal認証のproduction起動を拒否 |
| 見た目 | モバイルのホーム/会員画面、デスクトップ管理画面を画像確認。E2Eで横方向のはみ出しを確認 |

GitHub Actionsの設定は作成済みですが、リモートリポジトリへのpushやGitHub上のCI実行は行っていません。上記はローカル実行の結果です。

## セキュリティとデータ保護

- 公開版の更新・削除防止: 公開機能自体が未実装。Phase 2で公開本文・印・買い目のDB保護を実装します。監査ログの保護は今回実装・検証済み。
- 権限制御: 無料会員の管理API拒否、MFA前の管理者/専門家拒否、担当外レース拒否をAPIで検証。APIレスポンスから秘密値を除外。
- Webhook冪等性: 決済・LINE Webhookは未実装。手動権限付与の冪等性は今回実装・検証済み。
- .env、ローカル初期パスワード、メール、DBデータがGit管理外であることを確認。
- ローカルDBの所有者権限を本番へ流用しないこと、正式文書の同意を取り直すことを文書化。

## 当時の次フェーズ

この記録後、Phase 2のレース・評価・予想公開、Phase 3のLINE通知・Login・結果成績、Phase 4Aのローカル料金・契約基盤、Phase 5の無料登録から運用・退会まで、Phase 6のStripe、流入計測、無料募集モード、登録制御、メール公開通知まで実装しました。Supabase実環境、LINE・メールのライブ疎通、外部決済、CMS、人手による実機リハーサル、外部監視・障害連絡、本番用バックアップ基盤、個人情報の正式な匿名化、本番デプロイは未実施です。事業上の保留事項はDECISIONS.mdに残しています。
