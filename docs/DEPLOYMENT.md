# 独自ドメイン公開準備

## 一般公開前のクラウド試験

最初のRender配備は、staging専用PostgreSQLを先に作成・移行した後、`render.staging.yaml`をBlueprint Pathに指定して`STRIPE_SANDBOX`で実施する。`render.yaml`の一般公開用リソースとは名前とDBを分ける。Basic認証は使用せず、Web応答へ`no-store`と`X-Robots-Tag: noindex, nofollow`を付与する。管理機能と会員情報はアプリのログイン・ロール・AAL2で保護し、LINE Login、LINE通知、Stripe live modeを停止する。`BILLING_TRANSPORT=stripe`と`STRIPE_LIVE_MODE=false`を固定し、Stripeテストカードと署名付きテストWebhookで月額・1日利用・更新・失敗・回復・解約・権限反映を確認する。請求なし試験へ戻す場合は3サービスを`CLOUD_STAGING`へ、APIを`BILLING_TRANSPORT=test`へ同時変更する。APIはprivate serviceのため外部URLを持たない。

クラウド試験のプランは、APIとworkerを`0.5c-512mb`、WebとPostgreSQLを`free`へ固定する。Renderの2026年9月時点の表示価格では基本compute料金は月額14 USD（API 7 USD + worker 7 USD、秒単位の日割り）である。無料PostgreSQLは作成30日後に失効し、超過した帯域・build pipeline等は別条件となるため、作成直前にDashboardの最新見積りを再確認する。

Render Dashboardで次の値を入力する。値はGit、課題、チャットへ貼らない。

| 変数 | 設定先 | 条件 |
| --- | --- | --- |
| `APP_BASE_URL` / `ADMIN_BASE_URL` | staging API | staging WebのHTTPS URL |
| `ENCRYPTION_KEY` | staging API、worker | 両サービスで同一の32-byte base64値。本番とは別値 |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | staging API | staging専用Supabase project |
| `RESEND_API_KEY` / `MAIL_FROM` | staging API、worker | staging送信元。本番の会員リストを使用しない |
| `RESEND_WEBHOOK_SECRET` / `JOB_SECRET` | staging API | staging専用の値 |
| `DATABASE_URL` | staging API、worker | staging DBの制限付きruntime接続 |

配備後、ADMIN+AAL2で`/admin/settings`を開き、Stripeの`sk_test_` Secret key、テストWebhook endpointの`whsec_`、テスト用の3つのPrice IDを同じ保存操作で入力する。本番モードはOFFのままにする。Stripe側のWebhook URLは`https://<staging Webドメイン>/api/v1/webhooks/stripe`とし、`checkout.session.completed`、`invoice.paid`、`invoice.payment_failed`、`customer.subscription.updated`、`customer.subscription.deleted`を購読する。

配備前にAPI、Web、workerそれぞれの環境値をGit管理外ファイルへ用意し、`scripts/deployment-preflight.mjs`で検査する。Web検査では`CLOUD_STAGING`と`STRIPE_SANDBOX`の検索除外確認を案内する。画面と同一Origin APIへ`no-store`と`X-Robots-Tag: noindex, nofollow`が付与され、`/health`と署名付きprovider webhookは通常どおり到達できることを確認する。

staging DBの初回構築では、Blueprintより先に`umareal-staging-db`をSingapore、PostgreSQL 16で作成し、API・workerへ所有者接続を設定しない。Render Postgresの外部接続許可へ作業端末の現在IPだけを一時追加し、所有者接続で`pnpm db:migrate`と`pnpm db:access:configure`を実行する。runtime接続で`pnpm db:access:verify`が成功したら、API・workerへruntime URLを保存し、一時IP許可と端末上の所有者接続ファイルを削除する。以後の常駐サービスは所有者接続を保持しない。

`CLOUD_STAGING`と`STRIPE_SANDBOX`だけは開発版法務文書で起動できるが、管理画面の本番準備では法務ブロッカーを維持する。テスト環境を一般募集へ使用しない。`FREE_REGISTRATION`または`FULL`への切替前に正式文書を反映する。

## 配備版数の確認

RenderはWeb、API、workerを別々に配備するため、CI成功直後は一時的に版が揃わないことがある。`/health`はWeb、API、workerの短縮コミットID、worker最終生存時刻、3サービスの整合状態を返す。秘密値、ブランチ名、RenderサービスIDは返さない。

マイグレーション後に3サービスの配備が完了したことを次で確認する。

```bash
pnpm deploy:verify-releases -- https://umareal-staging-web.onrender.com
```

`CONSISTENT`かつworkerが`OK`の場合だけ成功する。`RELEASE_UNKNOWN`は旧版またはRender標準コミット値を取得できない状態、`RELEASE_MISMATCH`はサービス間の版ずれ、`WORKER_NOT_READY`はworker停止またはheartbeat遅延を示す。ローリング配備中は`/health`自体を停止させず、検査コマンドを再実行して完了を判定する。

mainの`Validate foundation`が成功すると、`.github/workflows/staging-release.yml`が同じ確認を最大12分繰り返す。GitHub Actionsの`Verify staging release`はmainに限り手動実行もでき、結果と対象短縮コミットをスマートフォンで読めるsummaryへ表示する。失敗しても既存サービスを停止・ロールバックしない。

このGitHub共有ランナーではDB migrationを実行しない。staging Postgresは外部接続元IPを作業端末へ限定しており、共有ランナーの変動IPを許可するためにDBを広く公開しないためである。migrationは本書冒頭と[DATABASE_ACCESS.md](DATABASE_ACCESS.md)のとおり、所有者接続を保護された一時実行環境だけへ設定して行う。完了後にGitHub Actionsの`Run workflow`からmainを再確認する。

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

1. Render Postgresを先に作成し、`docs/DATABASE_ACCESS.md` に従って所有者接続でマイグレーションを実行し、runtimeロールを構成・検証する。所有者接続をAPI・workerに保存しない。
2. RenderでこのGitHubリポジトリのBlueprintを選び、API、Web、workerと本番用secretを作成する。APIとworkerの `DATABASE_URL` には検証済みruntime接続だけを設定する。
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
