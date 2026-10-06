# 保守・拡張性監査

監査日: 2026-09-26

基準: `origin/main` `71a6a989ba43599f477b13de5b20c88d904d2015`

対象: 既存挙動を変えない開発規則、CI品質ゲート、将来の分割候補

この文書は実装済みの機能、PRだけに存在する機能、CIで確認した範囲、実環境で未確認の範囲を混同しないための監査記録である。認証、課金、紹介、閲覧権限、予想公開の業務仕様を変更する承認には使用しない。設計候補の実装時は `docs/SPEC.md` と `docs/DECISIONS.md` を改めて確認し、別PRで判断を記録する。

## 現在の状態

| 区分 | 確認内容 |
| --- | --- |
| `main`へ統合済み | 紹介制度V1、本番準備修正、請求例外運用、CI品質ゲート、配備版数確認、本番準備チェックのQuery Service分離。基準SHAは上記。紹介制度の詳細は `docs/REFERRAL_SYSTEM.md` を正とする |
| ブランチ・PRだけ | 監査時点の提案に残る未統合変更なし。各後続phaseは最新mainから別PRで実施する |
| CIで確認済み | mainのActions run `36221227908`。typecheck、lint、unit、JRA-VAN、DB/API integration、Stripeローカル結合、desktop/mobile E2E、全workspace build、Docker build、本番起動ガードが成功 |
| CIで意図的に未実行だった範囲 | 外部サービスのライブ疎通、本番・staging DB migration、実機SafariはCIの対象外 |
| 実環境・実機で未確認 | 本番Supabase、LINE Login/Messaging、Resend到達、Stripe sandbox/liveの外部API、独自ドメイン、実機iPhone、本番DB migration・制限ロール・バックアップ復元 |

テスト件数は監査時点の証跡であり、CIの合否条件には固定値として埋め込まない。追加した必須テスト段階は、対象が0件、skip、todo、失敗のいずれでも失敗させる。

## CIの検証範囲

| 段階 | コマンド・仕組み | 使用環境 | 保証する範囲 | 保証しない範囲 |
| --- | --- | --- | --- | --- |
| 生成・DB | `pnpm db:generate`, `pnpm db:migrate` | 毎回作るPostgreSQL 16 CI DB | Prisma生成、全migrationの新規DB適用 | 本番既存データ量、停止時間、運用者権限 |
| 静的検査 | `pnpm typecheck`, `pnpm lint` | 全workspace | 型とlint規則 | 実行時の外部サービス挙動 |
| 単体 | `pnpm test` | Node、mock中心 | domain/API/worker/Web単体、配備事前確認 | PostgreSQL・ブラウザ結合 |
| JRA-VAN | Python unittest | 合成fixture | オフライン変換・検証 | JV-Link契約、実データ取得 |
| DB/API結合 | `pnpm test:integration` | PostgreSQL、local auth、test transports、直列実行 | DB制約、API認可、監査、通知・請求のローカル経路 | 外部プロバイダーへの送信・請求 |
| Stripeローカル結合 | `pnpm test:integration:stripe-local` | Stripe形式の署名とtest-mode設定、外部通信なし | 署名、不一致、冪等Webhook、DB反映、設定元 | Checkout Session作成、Stripe CLI、テストカード、live決済 |
| ブラウザE2E | `pnpm test:e2e` | Chromium desktop/iPhone 13 viewport、local transports | 実ブラウザ導線、モバイル幅 | Safari実機、外部OAuth・メール到達 |
| build・起動防御 | `pnpm build`, Docker build, production guard | 合成された安全な設定 | 生成物作成、危険な本番設定の拒否 | クラウド基盤への配備と疎通 |

DB/API結合とE2Eは同じDBの全体設定やシングルトン行を扱うため、現状の `fileParallelism: false` と段階間のAPI再起動を維持する。速度だけを理由に無差別な並列化は行わない。

## 監査項目

### MA-001 Stripe専用結合テストの可視性

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `.github/workflows/ci.yml`, `package.json`, `scripts/run-required-vitest.mjs`, `tests/stripe-billing.integration.test.ts`
- 問題: 通常の結合段階ではStripe専用6件がskipされるため、CI全体の成功だけではStripe形式Webhookのローカル検証済み／未検証を区別しにくい。
- 影響: 署名、冪等性、金額不一致、契約ライフサイクルの回帰を見落とす可能性がある。
- 対応: 外部Stripe APIを呼ばない専用段階で既存テストを実行する。対象が0件、skip、todoの場合も失敗するランナーを使用する。既存テスト内容と請求機能コードは変更しない。
- 優先度: P0
- 検証: `BILLING_TRANSPORT=stripe`とtest-mode用の合成設定で `pnpm test:integration:stripe-local`。外部通信を行うCheckout作成はこの段階の対象外。

### MA-002 開発規則の時点依存

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `AGENTS.md`
- 問題: 冒頭の許可範囲が過去フェーズに固定され、現在の`main`や個別依頼の範囲と一致しなくなっていた。
- 影響: 過去の許可を新しい変更や本番操作へ誤って適用するおそれがある。
- 対応: 永続的な安全規則と現在フェーズの決め方を分離し、既存の保護規則を維持する。
- 優先度: P0
- 検証: 本番配備、ライブ資格情報、業務仕様変更が個別承認であること、および既存の公開版・認可・秘密情報・テスト規則が残ることをレビューする。

### MA-003 PR説明の必須情報

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `.github/pull_request_template.md`
- 問題: PRテンプレートがなく、API/DB影響、未実行試験、rollbackがレビューごとに抜ける可能性がある。
- 影響: レビュー時に本番影響と検証境界を判断しにくい。
- 対応: 目的、範囲、API/DB、検証、未実行、rollback、安全確認を含む小さなテンプレートを追加する。
- 優先度: P1
- 検証: 新規PR作成時にテンプレートが表示され、該当なしも明記できることを確認する。

### MA-004 API責務の集中（後続PR候補）

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `apps/api/src/auth.controller.ts`（387行）、`apps/api/src/app.controller.ts`（481行）、`apps/api/src/billing.controller.ts`（532行）
- 問題: HTTP入出力、認可、DB問合せ、外部プロバイダー変換、監査の複数責務がcontrollerへ集まり、変更時の影響範囲が大きい。
- 影響: 認証Cookie、AAL2、課金冪等性、閲覧権限などの重要境界を局所的に検証しにくい。
- 提案: 最初の実装候補は読み取り専用の管理readiness問合せをquery serviceへ移す。次に認証の登録／セッション／MFA orchestration、請求のprovider gateway／Webhook適用処理を別PRで分離する。endpoint、transaction、AuditLog、error codeは維持する。
- 優先度: P1
- 検証: 分離前後でAPI contract、DB/API結合、AAL1/AAL2拒否、冪等性、既存E2Eが同じ結果になることをcharacterization testで固定する。
- 実施状況: PR #7で最初のpilotをmainへ統合した。本番準備チェックのADMIN+AAL2認可はControllerへ残し、認可後の限定select、集計、判定、ローカル復元状態の読み取りだけを`ReadinessService`へ移した。既存15項目の順序と秘密情報非露出をintegration testで固定している。
- 認証セッション境界pilot: ローカル認証とSupabase認証のCookie属性、PKCE生成・flow Cookie、外部token取得を`AuthSessionService`へ集約し、メール認証、LINE Login、MFA、logout、退会が同じセッション境界を使用する。登録条件、Provider呼び出し、監査、API URL・応答、Cookie名・属性・有効時間は変更しない。これはController分離の最初の小規模phaseであり、登録・MFA・請求orchestration全体の分離完了を意味しない。
- 登録・メール確認orchestration pilot: メール会員登録、確認メール再送、ローカル確認トークン消費を`AuthRegistrationService`へ分離し、会員作成・同意・流入記録・紹介関係・監査のトランザクション境界をController外で検証できるようにする。Controllerは入力検証とCookie反映を担当し、API URL・応答、Supabase PKCE、登録条件、紹介成立条件、メール確認期限は変更しない。予備メール追加、ログイン、MFAの分離は後続候補のままとする。
- 認証資格情報orchestration pilot: LINE会員の予備メール設定、ローカルのパスワード再設定token発行・消費・全セッション失効、SupabaseのPKCE回復開始・パスワード更新を`AuthCredentialService`へ分離する。Controllerは入力検証、本人認証、Cookieからの外部token取得とPKCE Cookie反映を担当し、API URL・同一応答による会員有無の秘匿、15分期限、監査、セッション失効範囲は変更しない。ログインとMFAの分離は後続候補のままとする。
- MFA orchestration pilot: ローカルTOTPの暗号化登録・時刻ステップ再利用防止・AAL2セッション入替と、Supabaseの主／予備factor登録・challenge検証・競合防止・予備factor解除を`AuthMfaService`へ分離する。Controllerは入力検証、本人認証、サーバー所有ロールとAALによる事前認可、認証Cookie反映を担当し、API URL・応答、15分の未確認factor期限、監査、Provider全体logoutとローカルセッション失効範囲は変更しない。ログインorchestrationの分離は後続候補のままとする。
- ログインorchestration pilot: ローカル認証の同一コスト照合・確認済みメール判定・旧セッション破棄・新規セッション発行と、Supabase認証の会員照合・メール確認同期・初回ログイン記録・紹介成立・監査を`AuthLoginService`へ分離する。Controllerは入力検証、認証方式の分岐、Cookie反映を担当し、API URL・応答、エラーコード、AAL1開始、セッション期限、紹介成立条件は変更しない。callback・refresh・logoutの分離は後続候補のままとする。
- 認証セッションライフサイクルpilot: SupabaseのPKCE callback完了・会員照合・確認済みメール同期・signup時だけの紹介成立・refresh時の有効会員再確認・Provider logout監査と、ローカルlogoutの現セッション失効・監査を`AuthSessionLifecycleService`へ分離する。Controllerはcodeとflow Cookieの検証、成功・失敗リダイレクト、session Cookieの設定・削除を担当し、API URL・応答・リダイレクト先・監査・紹介成立条件・Cookie属性は変更しない。
- Stripe会員セルフサービスgateway pilot: 外部決済済み領収書URLの解決とStripe Customer Portal Session作成を`StripeCustomerGatewayService`へ分離する。Controllerは本人認証、支払い・契約の所有権確認、監査を担当し、Stripe Checkout、Webhook、返金、契約状態、API URL・応答・エラーコード、許可するStripe HTTPSドメインは変更しない。
- Stripe Webhook適用処理pilot: 署名・動作モード検証、イベント冪等性、Checkout完了、請求成功・失敗、契約更新・終了、返金同期を`StripeWebhookService`へ分離する。HTTP endpointはControllerに残し、課金イベントと通知eventのappend処理は共通関数を利用する。トランザクション、advisory lock、AuditLog、DayPass・Entitlement、API URL・応答・エラーコードは変更しない。管理者課金例外操作はこのpilotでは変更しない。
- Stripe Checkout作成pilot: 月額契約と一日利用の申込予約、重複・創設会員上限確認、Stripe Price照合、Checkout Session作成、監査を`StripeCheckoutService`へ分離する。Controllerは本人認証、確認済みメール判定、入力検証、idempotency key生成を担当し、API URL・応答・エラーコード・価格・有効期限・DB schemaは変更しない。管理者課金例外操作はこのpilotでは変更しない。
- 月額契約ライフサイクルpilot: 会員本人による解約予約・解約予約取消、Stripe契約同期、課金イベント、通知event、監査を`BillingSubscriptionLifecycleService`へ分離する。Controllerは起動モード・transport確認、本人認証、UUID検証を担当し、API URL・応答・エラーコード・支払済み期間の閲覧権限・DB schemaは変更しない。管理者課金例外操作はこのpilotでは変更しない。
- 管理者課金例外解決pilot: 要確認Checkoutの返金・閲覧権限付与と、公開待ちのまま期限を過ぎた購入一日券の返金を`BillingAdminResolutionService`へ分離する。ControllerはADMIN+AAL2、Stripe transport、UUIDと理由・解決方法の入力検証を担当する。既存のadvisory lock、Stripe冪等キー、支払履歴・課金event・通知event・AuditLogの追記、返金対象条件、API URL・応答・エラーコード・DB schemaは変更しない。外部Stripe APIを使うsandbox/live返金疎通は引き続き本番外の手動確認対象とする。
- 請求問い合わせpilot: 会員本人による問い合わせ受付、対象支払いの所有権確認、冪等受付と、管理者による状態遷移、追記イベント、AuditLogを`BillingSupportService`へ分離する。Controllerは認証、MEMBER/ADMIN+AAL2、入力検証、冪等キーとrequest hashの生成を担当する。既存のadvisory lock、問い合わせ状態遷移、append-only event、API URL・応答・エラーコード・個人情報の公開範囲・DB schemaは変更しない。
- ローカル課金シミュレーションpilot: `CLOUD_STAGING`等の請求なしtest transportで管理者が実行する月額支払失敗・回復、Entitlement期間更新、支払履歴、課金event、通知event、AuditLogを`BillingLocalSimulationService`へ分離する。Controllerは起動モード・test transport、ADMIN+AAL2、UUIDと理由の入力検証を担当する。猶予日数、状態遷移、API URL・応答・エラーコード・DB schemaは変更せず、Stripe契約は従来どおりWebhook同期だけを使用する。
- 会員請求読み取りpilot: 公開料金プランと会員本人の契約・一日利用・支払・請求問い合わせ履歴の限定問合せを`BillingQueryService`へ分離する。Controllerには本人認証を残し、創設会員枠、販売可否、Stripe Customer Portal表示条件、API URL・応答項目・DB schemaは変更しない。管理者請求一覧と申込処理はこのpilotに含めない。
- 管理者請求読み取りpilot: 契約、一日利用、支払、Stripe申込・Webhook、請求問い合わせ、期限切れ公開待ち一日券、要確認Checkoutの限定問合せを`BillingQueryService`へ分離する。ControllerにはADMIN+AAL2認可と共有Contract検証を残し、抽出条件、最大件数、並び順、API URL・応答項目・DB schema、管理操作は変更しない。
- ローカル申込pilot: 請求なしtest transportの月額・一日利用申込について、冪等性、創設会員枠、価格、契約・支払・閲覧権限、課金event・通知eventの同一トランザクション処理を`BillingLocalCheckoutService`へ分離する。Controllerにはtransport分岐、MEMBER本人認証、確認済みログイン、入力・日付・Idempotency-Key検証を残し、API URL・応答・エラーコード・期間・価格・DB schemaは変更しない。Stripe申込は既存`StripeCheckoutService`を維持する。
- 会員アカウント読み取りpilot: `GET /me`の本人情報、通知状態、有効な閲覧権限、同意履歴の限定取得と既存共有Contractへの整形を`MemberAccountQueryService`へ分離する。Controllerには本人認証を残し、通知状態・MFA・パスワード準備判定、API URL・応答項目・DB schemaは変更しない。DB取得列は応答判定に必要な項目だけへ限定し、認証subject、password hash、MFA secretは公開Contractから引き続き除外する。
- 会員退会orchestration pilot: `GET /me/closure`の月額・一日利用・進行中Checkoutの阻害確認と、`POST /me/close`のadvisory lock、再検査、退会記録・監査の追記、通知・LINE・閲覧権限・未使用認証フロー・全セッションの一括停止を`AccountClosureService`へ分離する。Controllerには本人認証、MEMBER限定、確認文言・理由・現在パスワード検証、成功後のCookie削除を残し、保持方針、API URL・応答、エラーコード、DB schemaは変更しない。
- 管理者ディレクトリ読み取りpilot: `GET /admin/users`と`GET /admin/audit`の限定select、ページング、監査検索、担当者表示名解決、共有Contractへの投影を`AdminDirectoryQueryService`へ分離する。ControllerにはADMIN+AAL2認可と入力検証を残し、API URL・検索条件・応答項目・並び順・DB schemaは変更しない。監査ログの任意JSON `details`はDB取得対象からも除外する。

### MA-005 DBアクセス境界（後続PR候補）

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `apps/api/src/app.controller.ts`, `apps/api/src/auth.service.ts`, `packages/db/prisma/schema.prisma`（1447行）
- 問題: controllerが共有Prisma clientを通して多数の集計を直接組み立てており、読み取り形状と認可前提がコード上で分散している。
- 影響: schema変更の波及が大きく、不要フィールド返却や認可条件の漏れをレビューしにくい。
- 提案: readinessの読み取り専用queryをpilotにし、入力、select、返却型を限定する。全repository化やPrismaの一括置換は行わない。
- 優先度: P2
- 検証: SQL回数・返却項目・権限・既存readiness E2Eを比較し、migrationなしで完了させる。

### MA-006 共有API contract（後続PR候補）

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `apps/api/src/referrals.controller.ts`, `apps/web/components/media-app.tsx`, `packages/domain/src`
- 問題: APIの実行時validationとWeb側の応答型が、機能によって個別に保守されている。
- 影響: nullable項目、状態名、権限制限の変更でサーバーと画面がずれる可能性がある。
- 提案: 既に安定している紹介の読み取りAPIを候補に、公開してよい応答だけをdomain packageのschemaから型導出する。秘密情報を含むDB modelの共有や全面移行はしない。
- 優先度: P2
- 検証: APIの無料／本人／管理者応答、モバイル画面、既存紹介integration/E2Eを固定する。
- 実施状況: `GET /me/referrals`を最初のpilotとして、公開応答だけを`packages/domain`の厳格なZod schemaで定義し、API境界の実行時検証とWebの型導出を同じContractへ接続した。続く小規模phaseで、同じ公開Reward schemaを再利用して`GET /me/referral-rewards`、`POST /me/referral-rewards/:id/redeem`、`GET /admin/referrals`、`GET /admin/referrals/:id`、`POST /admin/referrals/:id/invalidate`もContract化した。無効化の初回適用と冪等再送は既存の異なる応答形状をunionとして維持する。Prisma model、DB schema、URL、応答項目、紹介制度の業務仕様は変更しない。紹介制度V1の公開API Contract化は完了したが、全システムAPIのContract化は完了していない。
- 後続pilot: 紹介以外の最初の読み取りAPIとして`GET /admin/readiness`の既存15項目を共有Contractへ接続した。Query Service、ADMIN+AAL2認可、判定条件、順序、画面表示は変更していない。
- 通知運用pilot: `GET /admin/notifications`の配送一覧、試行履歴、LINE・メールWebhook集計、停止会員の既存応答を共有Contractへ接続する。通知の生成・送信・再送・停止解除、認可、DB schema、画面表示は変更しない。
- 通知テスト候補pilot: `GET /admin/notifications/test-options`の利用可能チャネル、通常予想、WIN5商品、月額契約の既存応答を共有Contractへ接続する。候補抽出条件、ADMIN+AAL2認可、テスト送信処理、宛先非公開は変更しない。
- 対象レース告知preview pilot: `GET /admin/notifications/previews/race-announcement`の既存応答を共有Contractへ接続する。対象人数の算出、ADMINのAAL2要件とOPERATORの既存認可、締切、本文、公開処理、画面表示は変更しない。無料速報previewはこのphaseに含めない。
- 無料速報preview pilot: `GET /admin/notifications/previews/free-report`の発走前速報・レース後検証の既存応答を共有Contractへ接続し、配信前確認UIの手書きAPI型を共有型へ置き換える。下書き検証、公開条件、対象人数、本文、認可、公開処理、画面表示は変更しない。
- 通知テスト送信応答pilot: `POST /admin/notifications/test-send`の成功応答と冪等再送の保存済み応答を同じ共有Contractへ接続し、通知管理・無料速報・配信予約画面の重複型を置き換える。宛先、送信処理、ADMIN+AAL2認可、監査、画面表示は変更しない。
- 配信予約一覧pilot: `GET /admin/publication-schedules`の開催日別レース、予約履歴、公開版別通知集計、警告の既存応答を共有Contractへ接続し、配信予約画面の手書き応答型を置き換える。予約作成・取消、公開処理、認可、集計条件、画面表示は変更しない。
- 障害監視一覧pilot: `GET /admin/incidents`の障害状態、検知事項、公開案内文、監視件数の既存応答を共有Contractへ接続し、障害対応画面の手書き応答型を置き換える。検知条件、ADMINとOPERATORの既存認可、画面表示、障害対応操作は変更しない。
- 運用アラート一覧pilot: `GET /admin/operational-alerts`のアラート、外部配送結果、状態別件数の既存応答を共有Contractへ接続し、障害対応画面の手書き応答型を置き換える。検知・配送・確認・解決・再送、認可、画面表示、設定APIは変更しない。
- 運用アラート設定pilot: `GET /admin/operational-alerts/settings`と`PATCH /admin/operational-alerts/settings`の共通応答を共有Contractへ接続し、障害対応画面の手書き応答型を置き換える。設定値、revision競合制御、ADMIN+AAL2更新、OPERATOR閲覧、監査、画面表示は変更しない。
- 運用アラート操作pilot: 確認済み、解決済み、外部配送再送APIの既存成功応答を共有Contractへ接続し、障害対応画面も同じ型を参照する。状態遷移、理由必須、ADMINとOPERATORの既存認可、監査、再送条件、返却項目は変更しない。
- 流入分析pilot: `GET /admin/acquisition`の集計期間、計測開始前会員数、発行済みキャンペーン、流入別登録・有料化件数の既存応答を共有Contractへ接続し、流入管理画面の手書き応答型を置き換える。集計条件、ADMIN+AAL2認可、キャンペーン作成、CSV出力、画面表示は変更しない。
- 無料登録ファネルpilot: `GET /admin/onboarding-funnel`の期間・流入元、登録からLINE受信準備までの5段階、有料化参考値、計測開始時刻の既存応答を共有Contractへ接続し、無料登録状況画面の手書き応答型を置き換える。集計条件、行動記録、ADMIN+AAL2認可、画面表示は変更しない。
- 本人確認フォローpilot: `GET /admin/registration-followups`の確認待ち会員、送信履歴、再送可否、状態別件数の既存応答を共有Contractへ接続し、本人確認フォロー画面の手書き応答型を置き換える。抽出条件、ADMIN+AAL2認可、再送処理、画面表示、DB schemaは変更しない。
- バックアップ検証状態pilot: `GET /admin/backups/status`の復元検証済み・失敗・未実施・不正ファイルの既存4応答を共有Contractへ接続し、バックアップ管理画面の手書き応答型を置き換える。ローカル状態ファイルの解釈、ADMIN+AAL2認可、復元検証処理、画面表示、DB schemaは変更しない。
- 会員向けお知らせ履歴pilot: `GET /me/notifications`のレース、WIN5、問い合わせ回答、課金通知とページ情報の既存応答を共有Contractへ接続し、会員向け配信履歴画面の手書き応答型を置き換える。本人認証、有料履歴の閲覧判定、既読処理、画面表示、DB schemaは変更しない。
- 公開レース一覧pilot: `GET /races`のレース基本情報、告知・最終予想の公開メタデータ、ページ情報、絞り込み状態の既存応答を共有Contractへ接続し、レース一覧画面と会員ホームの手書き応答型を置き換える。予想担当用レースAPIの画面内型とは分離する。公開条件、一覧の絞り込み、有料本文の詳細認可、画面表示、DB schemaは変更しない。
- 会員通知設定更新pilot: `PATCH /me/preferences`の既存5項目の応答を共有Contractへ接続し、マイページの保存処理も同じ型を参照する。設定項目、受信拒否時の再開制限、本人認証、監査、画面表示、DB schemaは変更しない。
- 公開予想詳細pilot: `GET /races/:raceId/prediction`の未公開、ロック済みメタデータ、閲覧可能な公開版の応答を共有Contractへ接続し、会員向け予想画面の手書き応答型を置き換える。下書きだけ存在する場合も既存画面が必要とするレース情報を返す。公開条件、有限期間権限、無料会員への本文制限、画面表示、DB schemaは変更しない。
- 公開確定結果pilot: `GET /races/:raceId/result`の未確定と確定済み結果・馬評価の既存応答を共有Contractへ接続し、会員向け結果表示の手書き応答型を置き換える。結果確定、訂正履歴、馬評価集計、画面表示、DB schemaは変更しない。
- 公開成績pilot: `GET /results/stats`の全体、信頼度別、競馬場別、馬場別、月別の既存応答を共有Contractへ接続し、会員向け成績画面の手書き応答型を置き換える。最新確定結果版の選択、馬評価集計ルール、画面表示、DB schemaは変更しない。
- 結果取込元一覧pilot: `GET /admin/results/import/providers`の取込元ID、表示名、形式版、CSV見出しの既存応答を共有Contractへ接続し、結果管理画面の手書き応答型を置き換える。取込方式、JRA-VAN連携、ADMIN+AAL2とOPERATORの既存認可、画面表示、DB schemaは変更しない。接続設定、資格情報、内部provider実装の追加を厳格なContractとcharacterization testで拒否する。
- 結果取込履歴pilot: `GET /admin/results/import/history`の確定済み取込元、CSV指紋、初回・訂正区分、bundle検証情報、担当表示名、対象レースの既存応答を共有Contractへ接続し、結果管理画面の手書き応答型を置き換える。最大30件の表示、取込・訂正処理、ADMIN+AAL2とOPERATORの既存認可、画面表示、DB schemaは変更しない。取込行、担当者ID、会員連絡先、接続設定、資格情報の追加を厳格なContractとcharacterization testで拒否する。
- 結果管理レース一覧pilot: `GET /admin/results/races`のレース基本情報、結果下書きの版・取込元、最新確定結果の版・確定時刻の既存応答を共有Contractへ接続し、結果管理画面の手書き応答型を置き換える。発走済み対象の抽出、並び順、最大100件、ADMIN+AAL2とOPERATORの既存認可、結果入力・確定処理、画面表示、DB schemaは変更しない。出走馬、下書き本文、予想担当、結果確認者、会員連絡先、接続設定、資格情報の追加を厳格なContractとcharacterization testで拒否する。
- 結果管理レース詳細pilot: `GET /admin/results/races/:raceId`のレース基本情報、出走馬の表示項目、編集可能な結果下書き、確定結果履歴の既存応答を共有Contractへ接続し、結果管理画面の手書き応答型を置き換える。未入力時の空理由・未確定着順、確定版の降順、ADMIN+AAL2とOPERATORの既存認可、下書き保存・CSV取込・結果確定、画面表示、DB schemaは変更しない。画面で不要な結果確認者IDをDB取得と応答から除外し、予想担当、出走馬詳細、更新者、認証・配信資格情報の追加を厳格なContractとcharacterization testで拒否する。
- 結果下書き保存・確定応答pilot: `PATCH /admin/results/races/:raceId`の新しい下書き版番号と、`POST /admin/results/races/:raceId/confirm`の結果版ID・版番号・冪等再送状態を共有Contractへ接続し、結果管理画面の手書き応答型を置き換える。楽観ロック、発走後制約、結果評価、公開済み結果の追記、監査、通知event、ADMIN+AAL2とOPERATORの既存認可、画面表示、DB schemaは変更しない。更新者、確認者、監査ID、会員情報、資格情報の追加を厳格なContractとcharacterization testで拒否する。
- 結果CSV取込応答pilot: 複数レースとレース単体のCSV差分確認・下書き反映APIについて、入力不備、重複、初回反映、公式訂正、冪等再送を含む既存応答を共有Contractへ接続し、結果管理画面の手書き応答型を置き換える。取込検証、JRA-VAN bundle照合、楽観ロック、取込履歴、監査、ADMIN+AAL2とOPERATORの既存認可、画面表示、DB schemaは変更しない。保存済み取込行、担当者ID、監査ID、会員情報、接続設定、資格情報の追加を厳格なContractとcharacterization testで拒否する。
- 公開WIN5成績pilot: `GET /win5/performance`の公開回数、対象レース数、勝ち馬候補内選出、中心馬の1着・連対・複勝率の既存応答を共有Contractへ接続する。集計対象の版選択、計算ルール、API URL、画面表示、DB schemaは変更しない。現在のWeb画面はこのAPIを使用していないため、未使用の画面型は追加しない。
- 公開WIN5一覧pilot: `GET /win5`の公開予定・公開版メタデータ、対象5レース、ページ情報の既存応答を共有Contractへ接続し、会員向けWIN5一覧画面の手書き応答型を置き換える。公開条件、無料会員への評価馬・理由・本文制限、詳細閲覧権限、画面表示、DB schemaは変更しない。
- 公開WIN5詳細pilot: `GET /win5/:productId`の未公開・無料向けメタデータと、月額・一日利用・許可されたスタッフ向け公開本文を判別可能な共有Contractへ接続し、会員向けWIN5紙面の手書き応答型を置き換える。公開版選択、有限期間権限、無料会員への評価馬・理由・総評・訂正理由制限、画面表示、DB schemaは変更しない。
- 会員向け登録特典pilot: `GET /me/free-benefit`の未設定と設定済み応答を共有Contractへ接続し、ホーム画面の手書き応答型を置き換える。会員認証、登録特典の内容・表示条件、管理画面、DB schemaは変更せず、管理用revision・更新者などは会員Contractに含めない。
- 会員向け無料速報メタデータpilot: `GET /races/:raceId/free-report`のレース基本情報と公開版番号・種別・時刻の既存応答を共有Contractへ接続し、会員向け予想画面の手書き応答型を置き換える。会員認証、公開処理、画面表示、DB schemaは変更せず、馬名・馬番・評価理由・音声・検証本文は会員Contractに含めない。
- 無料速報管理レース一覧pilot: `GET /admin/free-reports/races`の開催日別レース基本情報、下書きrevision、最新公開版メタデータの既存応答を共有Contractへ接続し、無料会員向け配信管理画面の手書き応答型を置き換える。ADMIN+AAL2とOPERATORの既存認可、対象抽出、画面表示、公開処理、DB schemaは変更せず、出走馬・評価理由・音声・検証本文・更新者情報は一覧Contractに含めない。
- 無料速報管理レース詳細pilot: `GET /admin/free-reports/races/:raceId`のレース、出走馬、下書き、公開履歴、結果確定メタデータの既存応答を共有Contractへ接続し、無料会員向け配信管理画面の手書き応答型を置き換える。Prisma modelをContractとして公開せず明示的なselectを使用する。ADMIN+AAL2とOPERATORの既存認可、入力内容、画面表示、保存・公開処理、DB schemaは変更しない。
- 無料速報管理更新pilot: 音声アップロード、下書き保存、初版・レース後検証公開と冪等再送の既存成功応答を共有Contractへ接続し、管理画面の手書き応答型を置き換える。取得列を明示し、音声形式もAPIとContractで共有する。音声内容検証、公開条件、締切、監査、通知event、画面表示、DB schemaは変更しない。
- ログイン中アカウントpilot: `GET /me`の本人情報、通知状態、有限期間権限、同意履歴の既存応答を共有Contractへ接続し、会員・スタッフ画面全体で使われていた手書き応答型を置き換える。本人認証、MFA判定、通知状態、閲覧権限、画面表示、DB schemaは変更せず、認証subject、password hash、MFA secret、紹介コードなどの内部情報をContractに含めない。
- 公開料金プランpilot: `GET /billing/plans`の料金、販売可否、残り創設会員枠、決済transport・Stripe modeの既存応答を共有Contractへ接続し、料金画面の手書き応答型を置き換える。価格計算、販売可否判定、申込処理、画面表示、DB schemaは変更せず、決済資格情報や管理設定の内部情報をContractに含めない。
- 会員向け契約・支払履歴pilot: `GET /billing/me`の月額契約、一日券、支払履歴、請求問い合わせ履歴を共有Contractへ接続し、会員画面の手書き応答型を置き換える。DB取得列を画面で必要な公開項目へ限定し、会員ID、決済事業者側ID、権利ID、支払と契約の内部紐付けID、問い合わせ対応理由を応答に含めない。申込・解約・一日券・領収書・問い合わせ、閲覧権限、管理画面、DB schemaは変更しない。
- 契約・請求管理一覧pilot: `GET /admin/billing`の契約、一日券、支払、Stripe申込・Webhook、請求問い合わせ、返金・決済要確認一覧を共有Contractへ接続し、管理画面の手書き応答型を置き換える。DB取得列を管理画面で必要な運用項目へ限定し、会員ID、決済事業者側の支払・契約ID、権利ID、支払と契約の内部紐付けIDを応答に含めない。ADMIN+AAL2認可、管理操作、内部対応理由の表示、請求処理、DB schemaは変更しない。
- 会員向け請求セルフサービス応答pilot: 月額申込、1日利用申込、Stripe領収書、Stripe Customer Portal開始の既存成功応答を共有Contractへ接続し、料金・アカウント画面の手書き応答型を置き換える。ローカル試験とStripeの応答差はunionで維持し、API URL、申込・クーポン・権限・冪等性、Stripe通信、画面表示、DB schemaは変更しない。厳格なContractにより、会員ID、決済事業者側ID、Entitlement IDなど既存応答にない内部項目の追加をCIで拒否する。
- 会員向け請求操作応答pilot: 月額契約の解約予約・継続再開と請求問い合わせ受付の既存成功応答を共有Contractへ接続し、アカウント画面も同じ型を参照する。冪等再送を含む応答項目、契約状態遷移、支払済み期間、問い合わせ内容・権限・監査、API URL、画面表示、DB schemaは変更しない。会員IDと決済事業者側IDなど既存応答にない内部項目の追加を厳格なContractとcharacterization testで拒否する。
- 管理者向け請求操作応答pilot: 要確認Checkoutの解決、期限切れ公開待ち一日券の返金、請求問い合わせ状態更新、ローカル試験の支払失敗・回復の既存成功応答を共有Contractへ接続し、管理画面も同じ型を参照する。ADMIN+AAL2認可、状態遷移、返金・Stripe処理、監査、API URL、画面表示、DB schemaは変更しない。会員ID、決済事業者側ID、操作担当者IDなど既存応答にない内部項目の追加を厳格なContractとcharacterization testで拒否する。
- 会員行動記録pilot: `POST /me/journey`の料金プラン閲覧、申込確認、LINE案内閲覧の入力と既存成功応答を共有Contractへ接続し、利用する3画面も同じ型を参照する。初回ログイン記録、重複防止、ファネル集計、MEMBER認可、API URL、画面表示、DB schemaは変更しない。会員IDなど既存応答にない情報の追加を厳格なContractとcharacterization testで拒否する。
- 退会条件確認pilot: `GET /me/closure`の退会可否、本人確認要否、契約・一日券・決済中の停止理由、保持方針の既存応答を共有Contractへ接続し、退会画面の手書き型を置き換える。MEMBER認可、退会条件、停止処理、保持対象、画面表示、DB schemaは変更しない。会員IDや請求内部IDなど既存応答にない情報の追加を厳格なContractとcharacterization testで拒否する。
- 退会完了応答pilot: `POST /me/close`の停止時刻、冪等状態、履歴保持フラグの既存成功応答を共有Contractへ接続し、退会画面も同じ型を参照する。本人認証、現在パスワード確認、advisory lock、契約再検査、通知・LINE・閲覧権限・全セッション停止、Cookie削除、保持対象、DB schemaは変更しない。退会記録ID、会員ID、監査IDなど既存応答にない情報の追加を厳格なContractとcharacterization testで拒否する。
- 退会記録管理一覧pilot: `GET /admin/account-closures`の退会記録、停止状態、会員表示情報、ページ情報の既存応答を共有Contractへ接続し、管理画面の手書き型を置き換える。ADMIN+AAL2認可、一覧順序、表示内容、保持方針、画面表示、DB schemaは変更しない。認証秘密、監査詳細、選択していないDB列の追加を厳格なContractとcharacterization testで拒否する。
- 会員管理一覧pilot: `GET /admin/users`の表示名、メール確認状態、登録方式、LINE連携状態、ロール、登録日時、ページ情報の既存応答を共有Contractへ接続し、管理画面の手書き型を置き換える。ADMIN+AAL2認可、一覧順序、表示内容、画面表示、DB schemaは変更しない。認証subject、password hash、MFA秘密、紹介コード、決済識別子、監査情報の追加を厳格なContractとcharacterization testで拒否する。
- 会員問い合わせ履歴pilot: `GET /support/me`の問い合わせ種別、件名、本文、状態、作成・更新時刻と、会員へ公開された追記・回答だけを共有Contractへ接続し、会員画面の手書き応答型を置き換える。MEMBER本人認可、最大100件と並び順、問い合わせ受付・追記・状態遷移、画面表示、DB schemaは変更しない。優先度、担当者、対応期限、会員識別情報、内部対応理由、監査情報の追加を厳格なContractとcharacterization testで拒否する。
- 問い合わせ対応管理一覧pilot: `GET /admin/support`の会員表示情報、問い合わせ内容、状態、優先度、担当者、対応期限、内部対応履歴と有効な担当候補を共有Contractへ接続し、管理画面の手書き応答型を置き換える。ADMIN+AAL2またはOPERATOR認可、最大200件、絞り込み、期限超過・優先度・期限・更新時刻による並び順、対応操作、画面表示、DB schemaは変更しない。認証subject、password hash、MFA秘密、決済識別子、監査情報、イベント担当者の連絡先の追加を厳格なContractとcharacterization testで拒否する。
- 問い合わせ操作応答pilot: 会員の問い合わせ受付・追記と、管理者またはレース担当による振り分け・状態更新の既存成功応答を共有Contractへ接続し、会員・管理画面も同じ型を参照する。冪等再送を含む応答項目、受付条件、状態遷移、担当者制約、回答通知、認可、監査、API URL、画面表示、DB schemaは変更しない。会員ID、操作担当者ID、監査ID、決済識別子など既存応答にない内部項目の追加を厳格なContractとcharacterization testで拒否する。
- スタッフ権限管理一覧pilot: `GET /admin/staff`の確認済みアカウント、担当件数、管理対象ロール、固定ポリシーの既存応答を共有Contractへ接続し、スタッフ権限管理画面の手書き応答型を置き換える。ADMIN+AAL2認可、最大200件、一覧順序、担当件数の算出、権限変更・担当移管・停止処理、画面表示、DB schemaは変更しない。認証subject、password hash、MFA秘密、決済識別子、監査情報の追加を厳格なContractとcharacterization testで拒否する。
- スタッフ権限管理操作応答pilot: ロール変更、担当移管、スタッフ利用停止・再開の既存成功応答を共有Contractへ接続し、スタッフ権限管理画面の手書き応答型を置き換える。ADMIN+AAL2認可、確認メールと理由、対象行ロック、担当・会員アクセス保護、セッション失効、監査、状態遷移、API URL、画面表示、DB schemaは変更しない。連絡先、認証情報、MFA秘密、監査情報など既存応答にない内部項目の追加を厳格なContractとcharacterization testで拒否する。
- 管理者継続運用状態pilot: `GET /admin/continuity`の有効・停止中管理者、昇格候補、主・予備MFA準備数、固定ポリシーの既存応答を共有Contractへ接続し、管理者継続運用画面の手書き応答型を置き換える。ADMIN+AAL2認可、管理者追加・停止・再開・降格、継続可能性判定、画面表示、DB schemaは変更しない。パスワード、認証subject、TOTP秘密、Provider factor ID、監査情報の追加を厳格なContractとcharacterization testで拒否する。
- 管理設定応答pilot: `GET /admin/settings`と`PATCH /admin/settings`の運用停止、価格、通知再試行、公開方針とStripe・メール・LINE・Bot対策の非秘密状態を同じ共有Contractへ接続し、管理設定画面の手書き応答型を置き換える。ADMIN+AAL2更新、OPERATOR閲覧、revision競合、暗号化保存、監査、設定値、画面表示、DB schemaは変更しない。API key、Webhook secret、LINE secret・token、暗号化値の追加を厳格なContractとcharacterization testで拒否する。
- 公開認証設定pilot: `GET /auth/config`の認証方式、公開モード、利用可能機能、登録可否、Bot対策と通知状態の既存応答を共有Contractへ接続し、全画面で使う手書き応答型を置き換える。公開モード、登録・LINE・課金・通知の判定、画面表示、DB schemaは変更しない。Supabase、Turnstile、LINE、Stripe、DBの資格情報と管理設定内部値の追加を厳格なContractとcharacterization testで拒否する。
- 管理ダッシュボード集計pilot: `GET /admin/summary`の会員・閲覧権限・レース・通知・結果・操作履歴件数、運用停止状態、無料登録ファネル、流入別有料化集計の既存応答を共有Contractへ接続し、管理ダッシュボードの手書き応答型を置き換える。ADMINとOPERATORの既存認可、集計式、最大20件、画面表示、DB schemaは変更しない。会員識別情報、メールアドレス、決済事業者側ID、監査詳細、資格情報の追加を厳格なContractとcharacterization testで拒否する。
- 開催日運用ボードpilot: `GET /admin/operations`の開催日別レース進捗、期限、警告、通知集計、6段階リハーサル、運用機能の事前確認を共有Contractへ接続し、管理ダッシュボードの手書き応答型を置き換える。ADMINとOPERATORの既存認可、進捗・期限・リハーサル判定、30秒更新、画面表示、DB schemaは変更しない。会員連絡先、LINE識別子、出走馬・評価本文、配送先、接続資格情報の追加を厳格なContractとcharacterization testで拒否する。
- SNS共有候補一覧pilot: `GET /admin/social-shares`の通常レースとWIN5の確定評価結果、共有可否、事実に限定した共有文・画像表示行の既存応答を共有Contractへ接続し、SNS共有管理画面の手書き応答型を置き換える。ADMINとOPERATORの既存認可、最新確定版の選択、共有文生成、画面表示、DB schemaは変更しない。会員連絡先、確認者、内部版ID、金額、SNS資格情報の追加と、種別・評価状態・結果URL・共有可否の矛盾を厳格なContractとcharacterization testで拒否する。
- 公開対象レース告知一覧pilot: `GET /announcements`の告知ID、版番号、公開日時とレース基本情報の既存応答を共有Contractへ接続し、会員ホームの手書き応答型を置き換える。公開済みかつ中止でないレースから各レースの最新版を最大10件表示する既存条件、並び順、画面表示、通知、DB schemaは変更しない。告知理由、作成者、担当者、出走馬、予想内容、会員連絡先、認証・配信資格情報の追加を厳格なContractとcharacterization testで拒否する。
- 予想作業向けパドック評価pilot: 評価作業領域、変更履歴、評価保存の3応答を共有Contractへ接続し、評価画面の手書き応答型を置き換える。DB取得列を画面に必要なレース、出走馬、評価本文、版、変更理由・時刻へ限定する。既存保存済みの冪等応答は互換読取後に同じ公開Contractへ整形する。担当EXPERTまたは全レースを扱うOPERATOR/ADMINとAAL2の認可、楽観ロック、端末下書き、競合解決、監査、変更履歴、画面表示、DB schemaは変更しない。評価ID、更新者、履歴スナップショット、操作担当者など画面で不要な内部項目の追加を厳格なContractとcharacterization testで拒否する。
- 予想対象レース一覧pilot: `GET /expert/races`の開催日、競馬場、レース番号・名称、発走時刻、状態を共有Contractへ接続し、予想画面の手書き応答型を置き換える。EXPERTは担当レースのみ、OPERATORとADMINは最大50件を発走時刻順で取得する。全ロールでAAL2を必須にし、画面表示とDB schemaは変更しない。レース管理詳細、担当者、内部revision、出走馬、予想・評価本文、認証情報の追加を厳格なContractとcharacterization testで拒否する。
- 通常予想編集読み取りpilot: `GET /expert/races/:raceId/prediction`のレース、評価に必要な出走馬とパドック所見、下書き、公開履歴、訂正方針を共有Contractへ接続し、予想画面の手書き応答型を置き換える。担当EXPERTまたは全レースを扱うOPERATOR/ADMINとAAL2の認可、下書き互換読取、公開版の降順、画面表示、保存・公開処理、DB schemaは変更しない。出走馬の管理項目、評価更新者、公開者、締切、版間リンク、スナップショットなど編集画面で不要な内部情報の追加を厳格なContractとcharacterization testで拒否する。
- 通常予想操作応答pilot: 下書き保存、公開前確認、初版・訂正版公開と冪等再送の成功応答を共有Contractへ接続し、予想画面の手書き応答型を置き換える。初版は担当EXPERT、OPERATOR、ADMINのAAL2、訂正版は既定でADMIN、設定時のみ担当EXPERTにも許可する。保存内容、楽観ロック、15分の確認期限、警告、締切、公開版・監査・通知の追記、画面表示、DB schemaは変更しない。公開前確認は画面で必要な馬番・馬名だけを返し、評価更新者、公開操作担当者、凍結snapshot、通知eventなどの内部情報の追加を厳格なContractとcharacterization testで拒否する。

### MA-007 CIジョブ構成

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `.github/workflows/ci.yml`, `vitest.integration.config.ts`, `playwright.config.ts`
- 問題: 1つの`validate`ジョブに全段階が入り、無名のstepが多いため、失敗した保証範囲の把握に時間がかかる。
- 影響: 障害切り分けが遅くなり、skipと未実行が見落とされやすい。
- 対応: 今回はstep名とStripe専用段階だけを追加する。DB共有と順序依存を理解せずjobを分割しない。
- 優先度: P1
- 検証: clean CI DBで全段階を実行し、失敗箇所がActions画面のstep名から分かることを確認する。

### MA-008 main保護設定

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象: GitHub repository settings（コード変更対象外）
- 問題: 監査時点でGitHub APIは`main`を「Branch not protected」と返し、repository rulesetも存在しなかった。
- 影響: CI未通過や未レビューの変更をmainへ直接反映できる。
- 提案: 管理者がGitHub上でmainへのPR必須、1名以上の承認、stale approvalの破棄、conversation解決、status check `validate`、force push・削除禁止を設定する。運用が安定したら管理者にも適用する。
- 優先度: P0（人による設定）
- 検証: 設定後にテストPRで未承認、CI失敗、force pushが拒否されることを確認する。今回のPRではGitHub設定を変更しない。

## 後続PRの順序

1. 読み取り専用readiness queryのpilotをレビュー・統合し、既存の認可・E2Eを固定する。
2. 紹介読み取り応答の共有schemaを1領域だけ試し、APIから返さない情報が増えていないことを確認する。
3. 認証と請求の分離はそれぞれ独立PRにし、同時に大規模リファクタリングしない。

どの段階でも既存migrationの書換え、公開済み予想・監査履歴の変更、本番データ操作、外部課金、実会員通知を含めない。

無料登録特典管理APIのpilotとして、`GET /admin/free-reports/benefit`と`PATCH /admin/free-reports/benefit`の既存レスポンスを`packages/domain`の共有Contractで固定した。未設定時と設定済み時の形を明示し、APIは取得列を限定してContractを検証し、Webは共有型から必要な編集項目だけをフォーム状態へ写す。認可、改訂番号、監査ログ、UI、DB schema、レスポンス内容は変更していない。これは無料速報領域の継続的な小規模導入であり、全APIのContract化完了を意味しない。

複数登録特典への拡張では、`GET/POST /admin/free-reports/benefits`、`PATCH /admin/free-reports/benefits/:benefitId`、`GET /me/free-benefits`の一覧Contractも同じ`packages/domain`へ追加し、APIとWebで共有した。旧単数Contractは段階的配備の互換境界として残している。Prisma Modelは公開Contractとして共有せず、会員向け一覧から動画URL、管理情報、個人情報を除外している。これは登録特典領域内の追加であり、全APIのContract化完了を意味しない。

## 本番外の確認手順

コードの品質確認が完了しても、公開判定では次を別に実施する。

1. Supabase本番相当環境で登録、メール確認、refresh、logout、AAL2を確認する。
2. LINEの許可CallbackとMessaging対象を限定して実アカウント試験する。
3. Resendの認証済みドメインで確認メール、通知、bounce webhookを確認する。
4. Stripe sandboxで実際のCheckout、テストカード、Stripe CLIまたはDashboard webhook、重複、不一致、返金運用を確認する。live keyはsandbox試験に使用しない。
5. 独自ドメイン、HTTPS、Origin、Cookie、noindexを確認する。
6. 実機iPhone Safariで会員・紹介・予想担当・管理画面の主要導線を確認する。
7. 本番migrationはバックアップ、制限付きruntime role、実行計画、rollback判断、責任者を確認して別作業で実行する。
