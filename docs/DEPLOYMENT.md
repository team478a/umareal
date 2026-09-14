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
| `SUPABASE_ANON_KEY` | API | Auth REST API用anon key。ブラウザーへは渡さずprivate APIで使用 |
| `RESEND_API_KEY` | API | 認証済み送信ドメインのkey |
| `MAIL_FROM` | API | 認証済みドメインのFromアドレス |
| `JOB_SECRET` | API | 32byte以上のランダム値 |
| `SENTRY_DSN` | API | 本番プロジェクトの監視先 |

LINEとStripeの秘密値は初回管理者を本番認証へ結合した後、AAL2で `/admin/settings` から暗号化保存する。APIとworkerには同じ `ENCRYPTION_KEY` が必要である。キーを失うと保存済みLINE・Stripe秘密値を復号できない。

Supabaseのservice-role keyは現行アプリでは使用しない。管理APIが必要になるまでRenderへ登録せず、anon keyだけで登録・ログイン・更新・JWT検証を行う。

## Supabase Auth設定

1. Email providerを有効にし、メール確認を必須にする。
2. Site URLを `https://{独自ドメイン}` にする。
3. Redirect URLsへ `https://{独自ドメイン}/api/v1/auth/callback` を完全一致で追加する。一時URLで限定試験する間は、その一時URLの同じパスも追加する。
4. 本番用SMTPをSupabase Authへ設定し、送信元ドメインのSPF/DKIMを確認する。
5. Password securityとBot/CAPTCHA設定を決める。CAPTCHAを有効にする場合は、登録APIへ検証トークンを渡す実装を追加してから募集を開始する。

登録とパスワード再設定はPKCEを使用する。コード検証値、アクセストークン、更新トークンはHttpOnly・SameSite=Lax・本番Secure Cookieだけに保存する。更新トークンによるセッション更新は同一Origin API中継が401を受けた場合に一度だけ実行する。ロールはSupabaseのuser metadataを使用せず、自社DBの値だけを参照する。

## 初回管理者とMFA

1. 独自ドメインの通常登録画面で、初回管理者本人が無料会員登録とメール確認を完了する。
2. Supabase DashboardのUsersで、その会員のUser UIDと確認済みメールアドレスが一致することを二人で確認する。
3. RenderのAPI Shellで、次の値をそのセッションだけに設定して `pnpm admin:bootstrap` を一度実行する。値をRenderの永続環境変数へ保存しない。

```text
BOOTSTRAP_ADMIN_SUBJECT={確認したSupabase User UID}
BOOTSTRAP_ADMIN_EMAIL={確認済みメールアドレス}
BOOTSTRAP_CONFIRM=CREATE_FIRST_ADMIN
```

処理はSupabaseモード、UUID、メール一致、メール確認済み、無効化されていないMEMBER、既存の有効ADMINが0人であることを同一トランザクション内で検証する。成功時はADMINへの変更と `INITIAL_ADMIN_BOOTSTRAP` 監査記録を同時に保存する。2回目以降は拒否する。

4. 管理者は再ログインし、`/security` でSupabase TOTP factorを登録する。表示されたsecretを認証アプリへ登録し、6桁コードを確認する。成功したセッションだけがSupabase署名済みJWTの `aal2` になり、管理機能へ進める。
5. 別ブラウザーで再ログインし、既存factorの6桁コードでAAL2へ昇格できること、AAL1のまま管理APIが403になることを確認する。

MFA端末紛失時のfactor解除・本人確認・再登録は、復旧責任者と本人確認基準が未決定のため管理画面から実行できない。募集開始前にSupabase Dashboardを使う緊急手順と二名確認を定める。

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

1. Supabase認証、初回管理者bootstrap、TOTP MFA経路は実装済みだが、本番project、Redirect URL、SMTPを使った登録・メール確認・ログイン・更新・ログアウト・AAL2の実環境試験が未実施である。MFA端末紛失時の復旧手順も未確定である。
2. 利用規約とプライバシーポリシーは `draft-v1` であり、正式同意として扱えない。
3. 個人情報の保持・匿名化、マイグレーション所有者とアプリDB権限の分離、本番バックアップの保持と復元責任者が未確定である。
4. LINE、Stripe、Supabase SMTP、監視のライブ資格情報と実環境試験が未実施である。
5. APIのレート制限はプロセス内保存である。初期はAPIを1インスタンスに固定し、複数インスタンス化の前に共有ストアへ移す。

次の公開準備ゴールは正式な利用規約・プライバシーポリシーの反映とする。その後、外部サービス資格情報を受け取り、Renderリソース作成、DNS設定、TLS確認、限定公開試験へ進める。
