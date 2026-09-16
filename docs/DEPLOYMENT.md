# 独自ドメイン公開準備

## 一般公開前のクラウド試験

最初のRender配備は`render.staging.yaml`をBlueprint Pathに指定し、`CLOUD_STAGING`で実施する。`render.yaml`の一般公開用リソースとは名前とDBを分ける。Web全体はBasic認証で保護し、LINE Login、LINE通知、Stripe決済を停止する。APIはprivate serviceのため外部URLを持たない。

Render Dashboardで次の値を入力する。値はGit、課題、チャットへ貼らない。

| 変数 | 設定先 | 条件 |
| --- | --- | --- |
| `STAGING_ACCESS_USERNAME` | staging Web | 半角英数字・ピリオド・アンダースコア・ハイフンで1〜64文字 |
| `STAGING_ACCESS_PASSWORD` | staging Web | 24バイト以上の固有ランダム値 |
| `APP_BASE_URL` / `ADMIN_BASE_URL` | staging API | staging WebのHTTPS URL |
| `ENCRYPTION_KEY` | staging API、worker | 両サービスで同一の32-byte base64値。本番とは別値 |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | staging API | staging専用Supabase project |
| `RESEND_API_KEY` / `MAIL_FROM` | staging API、worker | staging送信元。本番の会員リストを使用しない |
| `RESEND_WEBHOOK_SECRET` / `JOB_SECRET` | staging API | staging専用の値 |
| `DATABASE_URL` | staging API、worker | staging DBの制限付きruntime接続 |

配備前にAPI、Web、workerそれぞれの環境値をGit管理外ファイルへ用意し、`scripts/deployment-preflight.mjs`で検査する。Web検査はアクセス資格情報の不足や短いパスワードも拒否する。`/health`と署名付きprovider webhookはアクセスゲート対象外、それ以外の画面と同一Origin APIは未認証で401になることを確認する。

staging DBの初回構築では、API・workerへ所有者接続を設定しない。Render Postgresの外部接続許可へ作業端末の現在IPだけを一時追加し、所有者接続で`pnpm db:migrate`と`pnpm db:access:configure`を実行する。runtime接続で`pnpm db:access:verify`が成功したら、API・workerへruntime URLを保存し、一時IP許可と端末上の所有者接続ファイルを削除する。以後の常駐サービスは所有者接続を保持しない。

`CLOUD_STAGING`だけは開発版法務文書で起動できるが、管理画面の本番準備では法務ブロッカーを維持する。テスト環境を一般募集へ使用しない。`FREE_REGISTRATION`または`FULL`への切替前に正式文書を反映する。

## 採用する初期構成

初期公開先はRenderを候補にする。現在のモノレポを次の4リソースへ分け、公開入口はWebだけにする。

| リソース | Render種別 | 公開範囲 | 役割 |
| --- | --- | --- | --- |
| `umareal-web` | Web service | 独自ドメイン | Next.js画面、同一Origin API中継、Webhook受付 |
| `umareal-api` | Private service | Render内のみ | NestJS API |
| `umareal-worker` | Background worker | 受信なし | 予約公開、メール・LINE通知キュー |
| `umareal-db` | Render Postgres | 外部接続なし | 会員、予想、通知、監査履歴 |

`render.yaml` がこの構成を定義する。WebからAPIへはRenderのprivate hostを使う。LINEとStripeの公開URLはそれぞれ `https://{独自ドメイン}/api/v1/webhooks/line`、`https://{独自ドメイン}/api/v1/webhooks/stripe` とする。

## リポジトリ側で準備済みの内容

- `Dockerfile` でNode.js 22.15.0とpnpm 10.10.0を固定し、全workspaceをビルドする。
- 実行時は非rootユーザーを使う。
- APIはホスティング基盤の `PORT` を優先し、本番では `0.0.0.0` にbindする。
- Webの `/health` はprivate APIとDBまで到達できた場合だけ200を返す。
- Next.jsのAPI中継はCookie、認証、Range、冪等キーに加え、`Stripe-Signature` と `x-line-signature` を許可リストで転送する。
- DBマイグレーションは常駐サービスと分けた保護実行環境から、所有者接続で `pnpm db:migrate` を実行する。APIとworkerにはruntime接続だけを渡す。
- ワーカーはSIGTERM/SIGINTを受けると新しい処理ループへ進まず、DB接続を閉じる。
- GitHub Actionsが成功したコミットだけを自動配備対象にする。
- API private serviceにも`/api/v1/health`を設定し、DBへ到達できないインスタンスを正常扱いしない。

## 資格情報投入前の設定検査

Renderへ保存する値は、Git管理外の端末用ファイルへ準備し、サービスごとに次を実行する。

```powershell
node --env-file=.env.production.api.local scripts/deployment-preflight.mjs api
node --env-file=.env.production.web.local scripts/deployment-preflight.mjs web
node --env-file=.env.production.worker.local scripts/deployment-preflight.mjs worker
```

検査は値そのものを表示せず、必須項目、URL形式、32-byte暗号鍵、起動モード別transport、常駐サービスへ保存してはいけない所有者接続やservice-role keyを確認する。`MANUAL`は自動判定できない法務公開、DB実権限、外部サービス疎通、TLS、監視を示す。検査成功だけで公開を承認しない。

## Render作成時に入力する値

`sync: false` の値はRender Dashboardで入力する。値をGitへ追加しない。

| 変数 | 設定先 | 条件 |
| --- | --- | --- |
| `APP_BASE_URL` | API、worker | `https://{独自ドメイン}`。末尾スラッシュなし |
| `ADMIN_BASE_URL` | API | 初期は `APP_BASE_URL` と同じ |
| `ENCRYPTION_KEY` | API、worker | 同一の32-byte base64値。途中変更禁止 |
| `SUPABASE_URL` | API | 本番Supabase projectのHTTPS URL |
| `SUPABASE_ANON_KEY` | API | Auth REST API用anon key。ブラウザーへは渡さずprivate APIで使用 |
| `RESEND_API_KEY` | API、worker | 初回起動用。管理画面設定がない場合だけ使う認証済み送信ドメインのkey |
| `RESEND_WEBHOOK_SECRET` | API | 初回起動用。Resend Webhook endpointのsigning secret。管理画面設定がない場合だけ使う |
| `MAIL_FROM` | API、worker | 初回起動用。管理画面設定がない場合だけ使う認証済みドメインのFromアドレス |
| `JOB_SECRET` | API | 32byte以上のランダム値 |
| `SENTRY_DSN` | API | 本番プロジェクトの監視先 |

初回公開は `LAUNCH_MODE=FREE_REGISTRATION` とし、LINEとStripeのtransportを `disabled`、メールtransportを`resend`にする。初回起動時だけAPIとworkerへ同じResend設定を登録し、初回管理者を本番認証へ結合した後、AAL2で `/admin/settings` からAPI keyと送信元を暗号化保存できる。LINEとStripeの秘密値も`FULL`への拡張前に同画面から保存する。APIとworkerには同じ `ENCRYPTION_KEY` が必要である。キーを失うと保存済みメール・LINE・Stripe秘密値を復号できない。

Supabaseのservice-role keyは現行アプリでは使用しない。管理APIが必要になるまでRenderへ登録せず、anon keyだけで登録・ログイン・更新・JWT検証を行う。

## Supabase Auth設定

1. Email providerを有効にし、メール確認を必須にする。
2. Site URLを `https://{独自ドメイン}` にする。
3. Redirect URLsへ `https://{独自ドメイン}/api/v1/auth/callback` を完全一致で追加する。一時URLで限定試験する間は、その一時URLの同じパスも追加する。
4. 本番用SMTPをSupabase Authへ設定し、送信元ドメインのSPF/DKIMを確認する。
5. Password securityを確認する。Bot対策はアプリ管理画面のTurnstile設定を使用し、Supabase側の別CAPTCHAを重ねる場合は二重操作にならないことを実機で確認する。

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

## Turnstile設定

1. Cloudflare TurnstileでManaged widgetを作成し、限定公開用hostnameと独自ドメインを登録する。
2. APIの`CAPTCHA_TRANSPORT=turnstile`を確認する。Site keyとSecret keyはRender環境変数へ追加せず、初回管理者のAAL2設定後に`/admin/settings`へ保存する。
3. 管理画面の準備表示でSite key、Secret key、復号、サーバー検証、Turnstile transportを確認して有効化する。
4. 正常登録、未回答、不正回答、期限切れ、同じtokenの再送、Cloudflareへ接続できない場合を実端末で確認する。
5. `/admin/readiness`の`REGISTRATION_CAPTCHA`を確認する。外部疎通は自動で完了扱いにしない。

MFA端末紛失時のfactor解除・本人確認・再登録は、復旧責任者と本人確認基準が未決定のため管理画面から実行できない。募集開始前にSupabase Dashboardを使う緊急手順と二名確認を定める。

## 独自ドメイン設定の順序

1. RenderでこのGitHubリポジトリのBlueprintを選び、各リソースと本番用secretを作成する。APIとworkerの `DATABASE_URL` は自動入力せず、runtime接続を設定する。
2. `docs/DATABASE_ACCESS.md` に従い、所有者接続でマイグレーションを実行し、runtimeロールを構成・検証する。所有者接続をAPI・workerに保存しない。
3. 一時URLで `/health` が200を返し、GitHub Actions、API、workerの起動を確認する。
4. `umareal-web` に独自ドメインを追加する。
5. Renderが表示するA/CNAMEと所有確認用DNSレコードをドメイン管理会社へ登録する。固定値を推測して入力しない。
6. Renderでドメイン検証とTLS証明書発行を確認する。
7. `APP_BASE_URL` と `ADMIN_BASE_URL` を独自ドメインへ更新して再配備する。
8. Resend送信ドメインを独自ドメインへ揃える。LINE Login Callback、LINE Messaging Webhook、Stripe Webhookは`FULL`への拡張時に設定する。
9. Turnstileを設定・有効化し、`/admin/readiness` の自動判定と人による確認を完了して、無料登録・ログイン・確認メール・再設定・無料情報閲覧を少人数でリハーサルする。
10. 独自ドメインを公開導線へ載せる。Renderの一時サブドメインを無効にする場合は、独自ドメインでの復旧確認後に行う。

## 現在の公開ブロッカー

コンテナとドメイン経路は準備できるが、一般ユーザーの募集開始はまだできない。

1. Supabase認証、初回管理者bootstrap、TOTP MFA経路は実装済みだが、本番project、Redirect URL、SMTPを使った登録・メール確認・ログイン・更新・ログアウト・AAL2の実環境試験が未実施である。MFA端末紛失時の復旧手順も未確定である。
2. 利用規約とプライバシーポリシーは `draft-v1` であり、正式同意として扱えない。本文・版・施行日・公開状態が揃うまでproduction APIも起動を拒否する。反映手順は `docs/LEGAL_RELEASE.md` に記載した。
3. 個人情報の保持・匿名化と、本番バックアップの保持・復元責任者が未確定である。DB権限分離の実装は完了したが、本番DBでのruntimeロール構成と検証は未実施である。
4. 無料募集に必要なSupabase SMTP、Turnstile、監視のライブ資格情報と実環境試験が未実施である。LINEとStripeは`FULL`への拡張前に実施する。
5. APIのレート制限はプロセス内保存である。初期はAPIを1インスタンスに固定し、複数インスタンス化の前に共有ストアへ移す。

次の公開準備ゴールは、審査済みの利用規約・プライバシーポリシーを `docs/LEGAL_RELEASE.md` の手順で反映することとする。その後、外部サービス資格情報を受け取り、Renderリソース作成、DNS設定、TLS確認、限定公開試験へ進める。
