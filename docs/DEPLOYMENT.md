# 独自ドメイン公開準備

## 採用する初期構成

初期公開先はRenderを候補にする。現在のモノレポを次の4リソースへ分け、公開入口はWebだけにする。

| リソース | Render種別 | 公開範囲 | 役割 |
| --- | --- | --- | --- |
| `umareal-web` | Web service | 独自ドメイン | Next.js画面、同一Origin API中継、Webhook受付 |
| `umareal-api` | Private service | Render内のみ | NestJS API |
| `umareal-worker` | Background worker | 受信なし | 予約公開、LINE通知キュー |
| `umareal-db` | Render Postgres | 外部接続なし | 会員、予想、通知、監査履歴 |

`render.yaml` がこの構成を定義する。WebからAPIへはRenderのprivate hostを使う。LINEとStripeの公開URLはそれぞれ `https://{独自ドメイン}/api/v1/webhooks/line`、`https://{独自ドメイン}/api/v1/webhooks/stripe` とする。

## リポジトリ側で準備済みの内容

- `Dockerfile` でNode.js 22.15.0とpnpm 10.10.0を固定し、全workspaceをビルドする。
- 実行時は非rootユーザーを使う。
- APIはホスティング基盤の `PORT` を優先し、本番では `0.0.0.0` にbindする。
- Webの `/health` はprivate APIとDBまで到達できた場合だけ200を返す。
- Next.jsのAPI中継はCookie、認証、Range、冪等キーに加え、`Stripe-Signature` と `x-line-signature` を許可リストで転送する。
- DBマイグレーションはAPIの配備前コマンド `pnpm db:migrate` で実行する。
- ワーカーはSIGTERM/SIGINTを受けると新しい処理ループへ進まず、DB接続を閉じる。
- GitHub Actionsが成功したコミットだけを自動配備対象にする。

## Render作成時に入力する値

`sync: false` の値はRender Dashboardで入力する。値をGitへ追加しない。

| 変数 | 設定先 | 条件 |
| --- | --- | --- |
| `APP_BASE_URL` | API、worker | `https://{独自ドメイン}`。末尾スラッシュなし |
| `ADMIN_BASE_URL` | API | 初期は `APP_BASE_URL` と同じ |
| `ENCRYPTION_KEY` | API、worker | 同一の32-byte base64値。途中変更禁止 |
| `SUPABASE_URL` | API | 本番Supabase projectのHTTPS URL |
| `SUPABASE_ANON_KEY` | API | ブラウザー公開可能なanon key |
| `SUPABASE_SERVICE_ROLE_KEY` | API | サーバーだけで保持。実装上必要になる操作に限定 |
| `RESEND_API_KEY` | API | 認証済み送信ドメインのkey |
| `MAIL_FROM` | API | 認証済みドメインのFromアドレス |
| `JOB_SECRET` | API | 32byte以上のランダム値 |
| `SENTRY_DSN` | API | 本番プロジェクトの監視先 |

LINEとStripeの秘密値は初回管理者を本番認証へ結合した後、AAL2で `/admin/settings` から暗号化保存する。APIとworkerには同じ `ENCRYPTION_KEY` が必要である。キーを失うと保存済みLINE・Stripe秘密値を復号できない。

## 独自ドメイン設定の順序

1. RenderでこのGitHubリポジトリのBlueprintを選び、各リソースと本番用secretを作成する。
2. 一時URLで `/health` が200を返し、GitHub Actions、マイグレーション、API、workerの起動を確認する。
3. `umareal-web` に独自ドメインを追加する。
4. Renderが表示するA/CNAMEと所有確認用DNSレコードをドメイン管理会社へ登録する。固定値を推測して入力しない。
5. Renderでドメイン検証とTLS証明書発行を確認する。
6. `APP_BASE_URL` と `ADMIN_BASE_URL` を独自ドメインへ更新して再配備する。
7. LINE Login Callback、LINE Messaging Webhook、Stripe Webhook、Resend送信ドメインを独自ドメインへ揃える。
8. `/admin/readiness` の自動判定と人による確認を完了し、登録・ログイン・メール・LINE・決済を少人数でリハーサルする。
9. 独自ドメインを公開導線へ載せる。Renderの一時サブドメインを無効にする場合は、独自ドメインでの復旧確認後に行う。

## 現在の公開ブロッカー

コンテナとドメイン経路は準備できるが、一般ユーザーの募集開始はまだできない。

1. Web画面は現在、開発専用のローカル登録・ログインAPIを使用している。本番で必要なSupabaseの登録、メール確認、ログイン、セッション更新、ログアウトと、ローカル会員・同意履歴の作成が未結合である。
2. 利用規約とプライバシーポリシーは `draft-v1` であり、正式同意として扱えない。
3. 個人情報の保持・匿名化、マイグレーション所有者とアプリDB権限の分離、本番バックアップの保持と復元責任者が未確定である。
4. LINE、Stripe、Resend、Supabase、監視のライブ資格情報と実環境試験が未実施である。
5. APIのレート制限はプロセス内保存である。初期はAPIを1インスタンスに固定し、複数インスタンス化の前に共有ストアへ移す。

次の実装ゴールは本番Supabase認証の結合とする。これが完了すれば、正式文書と外部サービス資格情報を受け取り、Renderリソース作成、DNS設定、TLS確認、限定公開試験まで進められる。
