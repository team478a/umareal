# 競馬ファン向け会員制メディア

開発仕様書 v1.1 に基づく、Phase 0からPhase 6Tまでの実装です。メールだけで先行公開できる無料会員募集モード、管理画面からの新規登録停止・再開、確認待ち会員のフォロー、確認済み無料会員へのメール通知、メール配信資格情報と配信失敗の管理に加え、ローカルではLINEまたはメールからの無料登録、LP・キャンペーン流入計測、登録特典、無料パドック速報、配信予約とアラート、会員ホームでの行動案内、受信準備、Webお知らせ履歴とレース一覧の確認、対象レース告知、認証・会員設定、レース管理、評価入力、最終予想と訂正履歴、LINE通知・Login、結果確定と公開版別成績、料金・契約ライフサイクル、会員転換ファネル、開催日のライブ監視・リハーサル・障害対応、バックアップ復元確認、会員本人の退会を試せます。

LINE・Stripeへのライブ疎通、正式結果データ取込、返金、CMSは後続フェーズです。本番サービスとしては未完成です。

## 構成

- apps/web: Next.js App Router、React、TypeScript、Tailwind CSS。日本語・モバイル対応。
- apps/api: NestJS REST API。認証、入力検証、Origin検証、レート制限、共通エラー。
- apps/worker: 後続フェーズ用の実行境界。ジョブは未有効化。
- packages/db: PostgreSQL / Prisma、マイグレーション、ローカルシード。
- packages/domain: 権限、同意、1日利用のJST境界。
- レース管理画面: `/admin/races`。管理者は二段階認証後に利用。操作手順とCSV列定義は [docs/CSV_IMPORT.md](docs/CSV_IMPORT.md)。
- 評価入力画面: `/expert`。担当専門家または管理者が二段階認証後に利用。一時保存にはブラウザーのlocalStorageを使用します。
- 最終予想: 評価画面の「最終予想・公開へ」。公開前確認から初版を確定し、訂正は新しい版として追加します。会員表示は `/races/<raceId>`。
- 運用・連携設定: `/admin/settings`。管理者が二段階認証後に、新規会員登録、メール・LINE・Stripe資格情報、再試行方針、予想公開・CSV取込・通知・新規購入の停止状態を管理します。新規登録停止時は会員向け案内を必須とし、既存会員のログインは維持します。秘密値は保存後に再表示しません。
- 無料会員登録: `/register`。LINEを主経路とし、メール登録も利用できます。メール登録は30分有効の確認URLを開いて完了します。
- 流入計測: LPの登録リンクを `/register?utm_source=lp&utm_medium=owned&utm_campaign=launch` の形式にすると、メール・LINE登録とも初回流入を保存します。管理ダッシュボードで直近30日の無料登録数、有料化数、率を流入元・キャンペーン別に確認できます。
- キャンペーン管理: `/admin/acquisition`。管理者が監査理由付きで登録URLを発行・コピーし、7〜365日の流入集計を画面または個人情報を含まないCSVで確認できます。
- 対象レース告知: `/admin/races`。管理者・運営担当がスマートフォンから理由付きで告知し、無料会員向けLINE配送キューとホームのお知らせへ反映します。再告知は新しい版として追加します。
- 無料会員向け配信: `/admin/free-reports`。登録特典動画と、レースごとの評価UP馬・DOWN馬・理由・スマートフォン録音対応の本人音声・レース後検証を管理します。公開版と録音音声は追記専用で、会員のレース詳細とメール・LINE通知へ反映します。
- 配信予約・アラート: `/admin/publication-schedules`。対象レース告知と無料速報を予約し、期限接近、実行遅延、下書き変更による失敗、LINE配送失敗を確認できます。
- 利用準備: `/account`。無料登録、メール・LINE通知、予備ログイン、有料閲覧の状態をスマートフォン向け画面で確認できます。通知チャネルとカテゴリを本人が変更できます。
- 会員向けお知らせ: `/notifications`。対象レース告知、最終予想、訂正版の履歴をLINEの受信成否に関係なく確認できます。未読だけの表示と会員別の既読保存に対応します。
- レース一覧: `/races`。開催日、競馬場、告知・予想公開状態で絞り込み、未公開・無料公開・有料公開・訂正版を区別して詳細へ移動できます。
- 会員ホーム: `/`。ログイン中は未読、LINE受信状態、会員プランを表示し、現在の状態から優先する操作を1つ案内します。上部の通知ベルからも未読を確認できます。
- 会員転換ファネル: `/admin`。直近30日登録者と全期間について、無料登録、本人確認、LINE準備、料金閲覧、申込確認、有料化の人数を表示します。
- 無料登録ファネル: `/admin/onboarding-funnel`。7〜365日の登録コホートについて、本人確認、初回ログイン、LINE案内、LINE受信準備への到達・離脱を流入元別に表示します。個人別の行動は表示しません。
- 本人確認フォロー: `/admin/registration-followups`。確認待ちのメール登録を30分以内・30分以上で確認します。ローカル認証ではADMIN+AAL2が理由付きで再送でき、5分以内の重複を拒否します。Supabase認証ではPKCEを維持するため、本人のブラウザーで`/verify-email`から再送します。
- 開催日運用ボード: `/admin`。日付ごとに担当、告知、パドック入力、最終公開、通知、結果と期限警告を確認し、各作業画面へ移動できます。表示中は30秒ごとに自動更新されます。
- LINE会員連携: `/account`。LINE登録、既存会員への連携、LINEログインに対応します。LINE登録者は予備メールとパスワードを確認後に連携解除・有料申込できます。
- 結果・成績: `/admin/results` で結果を確定し、`/results` とレース詳細で公開版別の参考成績を確認できます。
- 料金・契約: `/plans` で内容を確認してから開発用申込、`/account` で契約・支払履歴と解約予約、`/admin/billing` で契約確認と支払失敗・回復のローカル試験を行えます。価格と販売可否は `/admin/settings` で管理します。
- バックアップ・復元確認: `pnpm db:backup:verify` で停止中のローカルPostgreSQLを物理コピーし、隔離ポートへ復元して整合性を確認します。管理者は `/admin/backups` で最終結果を確認できます。
- 退会・保持記録: 無料会員は `/account` で本人確認後に利用を停止できます。全セッション、通知、LINE、閲覧権限を停止し、管理者は `/admin/account-closures` で追記専用の退会記録を確認できます。
- 本番準備チェック: `/admin/readiness` で認証、外部接続、法務・データ、運用・復旧の不足項目と対応先を確認できます。資格情報は表示せず、この判定だけで公開を承認しません。
- 段階公開: `LAUNCH_MODE=FREE_REGISTRATION` ではメール無料登録と無料情報だけを提供し、LINE・Stripeを画面とAPIで停止します。`FULL`へ切り替えると従来のLINE・Stripe本番安全条件が有効になります。
- DB権限分離: `pnpm db:access:configure` でマイグレーション所有者とAPI・runtimeロールを分け、`pnpm db:access:verify` でCRUDとDDL拒否を検証します。手順は `docs/DATABASE_ACCESS.md` に記載しています。
- Stripe接続基盤: 外部決済モードではStripe Checkoutへ移動し、署名済みWebhookで金額・会員・申込を照合した後だけ契約と閲覧権限を作成します。月額更新、支払失敗・回復、解約予約・終了もWebhookから同期します。管理者は `/admin/settings` で暗号化資格情報、動作モード、Price IDを管理し、`/admin/billing` で申込と処理結果を確認できます。
- packages/config: 共通TypeScript設定。

## ローカル起動

Node.js 22.15以降、pnpm 10.10、Docker Composeを使用します。

```sh
pnpm install --frozen-lockfile
node scripts/local-init.mjs
docker compose up -d --wait db
pnpm db:generate
node scripts/with-env.mjs pnpm db:migrate
node scripts/with-env.mjs pnpm db:seed
pnpm --filter @keiba/domain build
pnpm --filter @keiba/db build
pnpm dev
```

ブラウザーで http://localhost:3000 を開きます。APIは http://127.0.0.1:4000/api/v1 です。`APP_BASE_URL` とブラウザーのOriginを一致させてください。既存の `.env` は初期化スクリプトで上書きしません。

ローカル初期化時にDBパスワードと暗号化キーを生成します。管理者・専門家の初期パスワードは `.local/dev-accounts.json` に保存されます。画面でログイン後、認証アプリに秘密キーを登録して二段階認証を完了してください。一般会員は登録画面から作成できます。ロールを選択する登録機能はありません。

ローカルの確認メールとパスワード再設定メールは外部へ送信せず `.local/mail/` に保存します。登録・予備メール確認は30分、パスワード再設定は15分有効です。リクエストのレスポンスには秘密トークンを返しません。

### このWindows環境でDockerが起動できない場合

検証時は `.local/postgres` に隔離したPostgreSQL 16バイナリを利用できます。Dockerと同時に同じポートで起動しないでください。プロジェクトの本体依存関係には含めていません。

```sh
npm install --prefix .local/postgres --no-audit --no-fund @embedded-postgres/windows-x64@16.14.0-beta.17
node scripts/local-postgres.mjs start
pnpm db:backup:verify
```

停止は `node scripts/local-postgres.mjs stop`。この補助処理はローカルDB専用で、データディレクトリを削除しません。バックアップ検証は元DBを短時間停止し、`.local/backups` に未暗号化の開発用物理コピーを残します。本番バックアップの代替ではありません。

## 検証

```sh
pnpm db:generate
pnpm --filter @keiba/domain build
pnpm --filter @keiba/db build
pnpm typecheck
pnpm lint
pnpm test
pnpm build
# 起動中のローカルDB/APIを使用。専用の検証アカウントを追加します。
node scripts/with-env.mjs pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

`.github/workflows/ci.yml` は専用PostgreSQLを起動し、マイグレーション・型検査・lint・単体・結合・E2E・ビルドを実行します。テスト用データを本番へ流さないでください。

結合試験とE2Eはそれぞれ認証リクエストを多数送るため、連続実行時はAPIを再起動するか1分空けてください。CIも段階間でAPIを再起動します。レート制限自体は有効です。WindowsではPrisma生成前にAPIを停止してください（使用中のDLL更新を避けるため）。

## 認証と本番接続の境界

`AUTH_PROVIDER=local` は開発専用です。本番モードで起動を拒否します。セッションはランダムなopaque tokenをHttpOnly cookieで渡し、DBにはハッシュのみ保存します。管理者と専門家はTOTP確認まで管理操作を拒否します。

`AUTH_PROVIDER=supabase` ではSupabase JWKSによる署名、issuer、audience、有効期限を検証し、authSubjectでローカルユーザーに対応付けます。ロールはDBから取得します。Supabaseの登録・メール確認・コールバック・セッション更新・ログアウトを含む本番のエンドツーエンド接続は未実施です。APIのJWT検証アダプターのみ準備済みです。

正式文書・料金・データ許諾の確定と、正式な同意の再取得が本番公開前に必要です。詳細は docs/DECISIONS.md、docs/OPERATIONS.md、docs/IMPLEMENTATION.md を参照してください。

独自ドメイン公開の構成、Render Blueprint、必要な資格情報と公開判定は [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) を参照してください。`render.yaml` はWeb、非公開API、ワーカー、PostgreSQLをSingaporeリージョンに作るための準備ファイルです。現時点では本番認証の結合と正式文書が未完了のため、公開トラフィックを受ける用途にはまだ使用しません。
