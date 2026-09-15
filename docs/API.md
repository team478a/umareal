# 実装済みAPIとWIN5追加API設計

基準URLは `/api/v1`。JSON。日時はISO 8601、時刻内部はUTC、画面はJST。レスポンスはno-store。全エラーにcode/message/requestIdを付与し、入力エラーはdetailsにフィールドパスを返す。

| Method | Path | 権限・動作 |
| --- | --- | --- |
| GET | /health | DB接続確認 |
| GET | /auth/config | 認証モード、公開モード、メール登録・無料情報・LINE・決済・登録CAPTCHAの公開機能状態。CAPTCHAは有効状態、Site key、transport区分だけを返し、秘密値を含まない |
| POST | /auth/register | メール無料登録を作成し確認メールを送信。有効時は2048文字以下のcaptchaTokenをCloudflareで再検証。任意のacquisition（標準UTM相当）を初回流入として固定。確認完了までセッションを発行しない |
| POST | /auth/email/resend | 開発認証のみ。未確認の登録メールを再送。登録有無を同一応答で伏せる |
| POST | /auth/email/verify | 30分有効の使い切りtoken。登録または予備メール確認を完了しセッションを発行 |
| POST | /auth/email/fallback | ログイン必須。LINE登録者の予備メール・パスワード確認を開始 |
| POST | /auth/login | 開発認証のみ。確認済みemail/password。HttpOnlyセッションcookie |
| POST | /auth/logout | ログイン必須。ローカルセッションを失効 |
| POST | /auth/password/request | 開発認証のみ。email。ローカルメール保存、同一応答で登録有無を伏せる |
| POST | /auth/password/reset | token/password。使い切り、15分有効。全セッション失効 |
| POST | /auth/mfa/enroll | ログイン必須。localは暗号化したTOTP secret、SupabaseはAuth側の未確認TOTP factorを作成。登録済みは再登録不可 |
| POST | /auth/mfa/verify | code、Supabase初回だけfactorId。challenge検証後にセッションをAAL2へ昇格。localは使用済み時刻ステップも拒否 |
| GET | /me | 本人の会員・通知・同意・有限期間権限。秘密情報を選択除外 |
| PATCH | /me/preferences | 本人。emailEnabled/predictions/changes/articles/billing（boolean）。配信拒否検出後のemailEnabled再開は拒否 |
| GET | /me/notifications | 本人。会員登録後に発生した対象レース告知と閲覧権限内の予想公開履歴。`page`、`limit`、`unread` |
| POST | /me/notifications/:eventId/read | 本人。閲覧可能なお知らせを冪等に既読化 |
| GET | /races | 全員。`date`、`venue`、`publication=ALL\|ANNOUNCED\|PUBLISHED\|UNPUBLISHED`、ページネーション。予想本文を含めない |
| GET | /races | 公開情報のみ、date（既定JST当日）、page/limit（既定1/20、最大50） |
| GET | /announcements | 今後の対象レース告知。レースごとの最新版を最大10件返す |
| GET | /expert/races | EXPERT+AAL2（担当のみ）またはADMIN+AAL2。最大50件の初期一覧 |
| GET | /expert/races/:raceId/workspace | 担当EXPERT+AAL2またはADMIN+AAL2。入力は無効 |
| GET | /admin/summary | ADMIN+AAL2またはOPERATOR。会員ファネルと直近30日の流入元・媒体・キャンペーン別登録/有料化を含む |
| GET | /admin/onboarding-funnel | ADMIN+AAL2。`days=1..365`と任意の`source`で登録コホートを絞り、本人確認、初回ログイン、LINE案内、LINE受信準備の人数・率・前段階からの未到達数を返す。個人情報は返さない |
| GET | /admin/registration-followups | ADMIN+AAL2。メール確認待ちの有効な無料会員を`status=ALL\|RECENT\|OVERDUE`とpage/limitで取得。確認メールの送信時刻と再送可否を返し、tokenやpassword hashは返さない |
| POST | /admin/registration-followups/:userId/resend | ADMIN+AAL2。ローカル認証だけで利用可能。`reason`必須。確認メールを再発行して監査へ追記し、同じ会員への5分以内の再送を409で拒否 |
| GET | /admin/acquisition | ADMIN+AAL2。集計日数、発行済みキャンペーンURL、流入別登録・有料化集計 |
| POST | /admin/acquisition/campaigns | ADMIN+AAL2。理由付きで一意コードの登録URLを発行し監査 |
| GET | /admin/acquisition/export.csv | ADMIN+AAL2。`days=1..365`の個人情報を含まない流入別集計CSV |
| GET | /admin/operations?date=YYYY-MM-DD | ADMIN+AAL2またはOPERATOR。JST運用日のレース進捗・期限・警告、6段階のリハーサル判定、運用機能の事前確認を返す |
| GET | /admin/incidents | ADMIN+AAL2またはOPERATOR。機能停止、通知遅延・失敗・停滞、未照合Webhook、案内文案を返す。秘密値は返さない |
| GET | /admin/backups/status | ADMIN+AAL2。最後のローカル隔離復元検証の状態、ハッシュ、件数照合結果を返す。資格情報と絶対パスは返さない |
| GET | /admin/readiness | ADMIN+AAL2。認証・外部接続・法務データ・運用復旧の準備状態、根拠、次の対応を返す。秘密値を返さず、公開承認には使わない |
| GET | /me/closure | 本人。退会可否、契約・1日利用の阻害要因、保持対象を返す |
| POST | /me/close | MEMBER本人。確認文言と、パスワード設定済みなら現在のパスワードが必須。セッション、通知、LINE、閲覧権限を停止し退会記録を追記 |
| GET | /admin/account-closures | ADMIN+AAL2。退会処理済み会員と保持方針バージョンをページング表示 |
| POST | /me/journey | MEMBER本人。`LINE_GUIDANCE_VIEWED`、`PLAN_VIEWED`または`CHECKOUT_REVIEWED`の初回到達を冪等記録。初回ログインは認証成功時にサーバーが記録 |
| POST | /billing/checkout | 本人。月額申込。test transportはローカル即時確定、stripe transportはCheckout URLを返し権限をまだ付与しない |
| POST | /billing/day-pass | 本人。JST開催日の1日利用。stripe transportでは署名済みWebhook後だけ有効化 |
| POST | /webhooks/stripe | Stripe署名必須。Checkout申込、会員、金額、通貨、動作モードを照合し、契約・支払・有限期間権限を冪等作成 |
| POST | /billing/subscriptions/:id/cancel | 本人の月額解約予約。Stripe契約は外部API成功後にローカルへ反映 |
| GET | /admin/users | ADMIN+AAL2。page/limit |
| GET | /admin/audit | ADMIN+AAL2。page/limit |
| GET | /admin/settings | ADMIN+AAL2またはOPERATOR。秘密値を除く運用・Turnstile・メール・LINE・Stripe設定と接続準備状態 |
| PATCH | /admin/settings | ADMIN+AAL2。revisionと理由必須。Turnstile・メール・LINE・Stripe資格情報、料金、通知方針、緊急停止を更新 |
| GET | /admin/notifications | ADMIN+AAL2またはOPERATOR。受信者単位の配送、試行履歴、状態別件数。page/limit/status/channel（EMAILまたはLINE）/raceId |
| GET | /admin/notifications/previews/race-announcement | ADMIN+AAL2またはOPERATOR。raceIdと任意のscheduledAtから、告知の次版、対象会員数、チャネル別候補・予定配送数、本文、配信時刻を返す。会員識別情報は返さず、データは変更しない |
| GET | /admin/notifications/previews/free-report | ADMIN+AAL2またはOPERATOR。raceId、kind、保存済みdraft revisionと任意のscheduledAt（発走前速報のみ）から、無料速報またはレース後検証の次版、対象会員数、チャネル別件数、本文、配信時刻を返す。公開条件を検証するがデータは変更しない |
| POST | /admin/notifications/test-send | ADMIN+AAL2。配信前確認と同じraceId・contentType・draftRevisionから管理者本人のLINEまたは確認済みメールへテスト送信。理由とIdempotency-Key必須 |
| POST | /admin/notifications/:notificationId/retry | ADMIN+AAL2またはOPERATOR。FAILED配送を理由付きで再送待ちへ戻し監査 |
| POST | /admin/notifications/email-blocks/:userId/release | ADMIN+AAL2。受信可能になったことを確認後、理由付きで配信拒否停止を解除。本人のemailEnabledは自動再開しない |
| POST | /webhooks/resend | Resend署名必須。バウンス・苦情・配信抑止を追記記録し、照合会員の公開通知メールを停止 |
| POST | /webhooks/line | LINE署名必須。follow/unfollowを冪等受付し、連携済みアカウントの通知可否を更新 |
| POST | /auth/line/start | REGISTER、LOGIN、LINKのstate・nonce・PKCE付きOAuthフローを開始。REGISTERのみ任意のacquisitionをサーバー内フローへ固定 |
| GET | /auth/line/callback | code/stateを使い切り、ID tokenを検証して15分の登録grant発行、連携、またはログイン |
| POST | /auth/line/register | 登録grant、表示名、成人・文書同意を使い無料会員とセッションを作成 |
| POST | /auth/line/unlink | 本人のLINE連携を履歴付きで解除。確認済み予備メール・パスワード必須 |
| GET | /admin/results/races | ADMIN+AAL2/OPERATOR。発走済み・予想公開済みの結果対象一覧 |
| GET/PATCH | /admin/results/races/:raceId | 結果下書きの取得／revision付き保存 |
| POST | /admin/results/races/:raceId/confirm | 結果版と公開予想版・買い目別精算を同一トランザクションで追記 |
| GET | /races/:raceId/result | 最新確定結果と公開版別精算 |
| GET | /results/stats | 最新結果版を使った公開版別参考集計 |
| GET | /billing/plans | 税込価格、販売可否、創設会員残枠。開発条件フラグ付き |
| GET | /billing/me | 本人の月額契約、1日利用、追記専用支払履歴 |
| POST | /billing/checkout | 本人。確認済みメール・パスワード必須。FOUNDER/STANDARDの申込。Stripe時はHosted Checkout URLを返す。Idempotency-Key必須 |
| POST | /billing/day-pass | 本人。確認済みメール・パスワード必須。JST開催日単位の申込。Stripe時はHosted Checkout URLを返す。Idempotency-Key必須 |
| POST | /webhooks/stripe | Stripe署名必須。Checkout完了、月額更新、支払失敗・回復、解約予約・終了を冪等反映 |
| POST | /billing/subscriptions/:id/cancel | 本人。次回更新を停止し、支払済み期間の権限を維持 |
| GET | /admin/billing | ADMIN+AAL2。全会員の契約・1日利用・支払試行履歴 |
| POST | /admin/billing/subscriptions/:id/simulate-failure | ADMIN+AAL2。理由必須のローカル支払失敗試験 |
| POST | /admin/billing/subscriptions/:id/recover | ADMIN+AAL2。理由必須のローカル支払回復試験 |
| POST | /admin/users/:userId/entitlements | ADMIN+AAL2。startsAt/endsAt/reason/planCode=MANUAL。有限期間、監査必須。Idempotency-KeyヘッダーにUUID必須 |

変更系はAPP_BASE_URLとのOrigin一致が必須。SupabaseモードはBearer JWTを署名検証し、DB上のauthSubjectと照合する。役割はJWTの任意ユーザーメタデータから採用しない。

HTTP 400=入力不正、401=未認証、403=権限/MFA/Origin不正、404=対象なし、409=重複、429=レート超過。内部例外のSQLや秘密値をレスポンスへ返さない。

返金APIは未実装。申込は同じ会員・同じキー・同じ内容なら元の結果を返し、異なる内容の再利用は409。同時実行でも契約、権限、支払履歴が重複しないよう、一意制約、アドバイザリロック、トランザクションで保護する。

## WIN5 API（設計確定・未実装）

管理用URLでもロールを推測せず、サーバー所有のロール、署名済みAAL、商品担当を検証する。WIN5の変更系はすべてAAL2、理由、Idempotency-Keyまたはrevisionを必須とする。

### 商品・対象レース管理

| Method | Path | 権限・動作 |
| --- | --- | --- |
| GET / POST | /admin/win5 | ADMIN+AAL2またはOPERATOR+AAL2。一覧／WIN5商品作成 |
| GET / PATCH | /admin/win5/:win5Id | ADMIN+AAL2またはOPERATOR+AAL2。商品詳細／公開前の基本情報更新 |
| POST | /admin/win5/:win5Id/races | ADMIN+AAL2またはOPERATOR+AAL2。対象レース追加 |
| PUT | /admin/win5/:win5Id/races/:legNumber | ADMIN+AAL2またはOPERATOR+AAL2。対象順1〜5の設定をrevision付きで置換 |

商品は`type=WIN5_PREVIEW`で対象日ごとに1件。対象レースは商品対象日と同日、対象順とraceIdはいずれも商品内で重複不可とする。公開版が存在しても下書き編集はできるが、公開済み版は変更しない。

### 専門家入力・公開

| Method | Path | 権限・動作 |
| --- | --- | --- |
| GET | /expert/win5/:win5Id | 担当EXPERT+AAL2またはADMIN+AAL2。編集用商品、5レース、出走馬、下書き、公開履歴 |
| PUT | /expert/win5/:win5Id/races/:legNumber | 担当EXPERT+AAL2、ADMIN+AAL2、またはOPERATOR+AAL2。中心馬、選択馬、理由、信頼度、戦略をrevision付き保存 |
| POST | /expert/win5/:win5Id/preview | 同上。5レース、選択、計算、締切、公開範囲を検証し15分有効のpreviewIdを返す |
| POST | /expert/win5/:win5Id/publish/:previewId | 同上。初版公開版、監査、通知eventを同一トランザクションで追記 |
| POST | /admin/win5/:win5Id/correct/:previewId | ADMIN+AAL2。訂正理由を必須にし、新版を追記 |

プレビューと公開確定は対象5レースの最小`startsAt`を締切として再検証する。公開後の通常PATCH、DELETE APIは提供しない。組み合わせ数と想定購入総額はサーバーで再計算し、クライアント値を信用しない。

### 会員閲覧

| Method | Path | 権限・動作 |
| --- | --- | --- |
| GET | /win5 | 公開商品の一覧。`date`、`page`、`limit` |
| GET | /win5/:win5Id | 認証・契約・公開範囲に応じた最新紙面または無料メタデータ |
| GET | /win5/:win5Id/versions | 閲覧可能な公開版履歴。各版を独立して権限判定 |

無料・未認証向けDTOは商品ID、対象日、タイトル、公開状態・時刻、対象レースの競馬場・番号・発走時刻と、公開を許可した全体信頼度だけを返す。選択馬、馬番、中心馬、理由、金額、総評、訂正理由、パドック評価を取得・返却しない。有料会員と有効な1日利用者には公開済みスナップショットを返す。

### 通知・結果・共有（WIN5 Phase 4、現在の実装許可範囲外）

| Method | Path | 権限・動作 |
| --- | --- | --- |
| POST | /admin/win5/:win5Id/results/import | ADMIN+AAL2またはOPERATOR+AAL2。5レースの確定結果版を参照して結果下書きを作る |
| POST | /admin/win5/:win5Id/results/confirm | ADMIN+AAL2またはOPERATOR+AAL2。判定対象の商品版を固定して結果版を追記 |
| GET | /win5/performance | 通常馬券と分離したWIN5成績 |
| GET | /admin/win5/:win5Id/share | ADMIN+AAL2。結果確定後の共有文、URL、画像データ |

通知種別は`WIN5_PREVIEW_PUBLISHED`、`WIN5_PREVIEW_CORRECTED`、`WIN5_RESULT_CONFIRMED`。同じ公開版・受信者・チャネル・種別を冪等キーで一意にし、通知失敗は商品公開を取り消さない。例外結果が`REVIEW_REQUIRED`の間は結果確定、成績反映、的中表示、共有画像生成を拒否する。

### エラーコード

- `WIN5_DUPLICATE_TARGET_DATE`: 同じ対象日の商品が存在する
- `WIN5_LEGS_INCOMPLETE`: 対象5レースが揃っていない
- `WIN5_DUPLICATE_RACE`: 同じレースが複数の対象順にある
- `WIN5_SELECTION_REQUIRED`: 選択馬または中心馬が不足している
- `WIN5_DRAFT_CONFLICT`: 下書きrevisionが一致しない
- `WIN5_STALE_PREVIEW`: 確認後に商品、レース、出走馬、選択、公開履歴が変わった
- `WIN5_PUBLICATION_CLOSED`: 最初の対象レースの発走時刻以降である
- `WIN5_ACCESS_DENIED`: 契約、対象日、公開範囲を満たさない
- `WIN5_RESULT_REVIEW_REQUIRED`: 例外結果の集計規則が確定していない

## 料金・契約

`BILLING_TRANSPORT=test` はローカル検証専用で、外部通信、カード入力、実請求を行わない。`stripe` はHosted Checkoutと署名付きWebhookを使用する。`LAUNCH_MODE=FREE_REGISTRATION` の本番では `disabled` を必須にし、購入画面を表示せず、CheckoutとWebhookを503で拒否する。新規購入停止は月額と1日利用の両方へ適用する。

`GET /api/v1/auth/config` は新規登録の受付状態と、停止中だけ会員向け案内を返す。`POST /api/v1/auth/register`、LINEの新規登録開始・確定は、管理設定で停止中の場合 `REGISTRATION_PAUSED`（503）を返す。ログイン、メール確認、パスワード再設定は停止対象に含めない。切替は `PATCH /api/v1/admin/settings` でADMIN+AAL2、現在のrevision、変更理由、停止時の会員向け案内を必須とする。

確認済みメール会員への公開通知は、メール通知全体と本人の`emailEnabled`・カテゴリ設定を送信直前に確認する。通知eventは共通だが、メールとLINEの配送、冪等キー、展開状態は独立する。既存eventは移行時にメール展開済みとし、導入前の告知を一斉送信しない。公開通知の停止は認証用メールへ影響しない。

ローカル月額契約は申込時刻からUTC基準の暦1か月を計算し、Stripe月額契約はInvoiceの請求期間を正とする。`invoice.paid` は初回期間補正、更新、回復を反映し、`invoice.payment_failed` はPAST_DUEと設定済み猶予期限を反映する。`customer.subscription.updated/deleted` は解約予約・終了を同期する。現行の1日利用は対象日のJST 00:00以上、翌日00:00未満。WIN5 Phase 3で、WIN5商品がある日は初版の実公開時刻から、商品がない日は対象日JST 00:00からへ移行する。支払試行、請求イベント、Stripe受信イベントはDBで更新・削除・TRUNCATEを拒否する。

## 運用・連携設定

`GET /admin/settings` はMessaging APIとLINE LoginのChannel ID、Callback URL、各秘密値が設定済みかだけを返す。秘密値そのもの、暗号文、末尾文字は返さない。`PATCH` の空欄は保存済み秘密値を維持し、削除は専用booleanで明示する。秘密値はAES-256-GCMで暗号化し、監査ログには変更の有無だけを記録する。

Resend API key、送信元、Webhook signing secretも同じAPIで管理する。secretは暗号化し、設定済み・復号可能だけを返す。管理設定のいずれか一項目でも存在する場合はDB設定一式を優先し、環境変数と混在させない。管理設定がない場合だけ`RESEND_API_KEY`、`MAIL_FROM`、`RESEND_WEBHOOK_SECRET`を初回起動用の代替として使用する。外部疎通は状態表示に含めず、本番接続時に別途確認する。

StripeもSecret keyとWebhook secretは同じ暗号化方式で保存し、設定済み・復号可能だけを返す。Price IDは管理画面へ返す。管理設定が1項目でも存在する場合はDB設定一式を優先し、環境変数と混在させない。Secret keyのtest/live接頭辞、選択モード、3つのPrice IDを照合し、不完全な状態ではStripe購入とWebhook処理を開始しない。

設定更新はrevisionによる楽観ロックを使用し、不一致は409 STALE_REVISION。LINE通知の有効化にはMessaging APIのChannel ID、Channel secret、Channel access token、LINE Loginの有効化には専用Channel ID、Channel secret、Callback URLが必要。アプリ検証に加えてDB CHECK制約でも不完全な有効化を拒否する。通知最大試行回数は1〜10、初回待機は10〜3600秒。Messaging API transport、Webhook、LINE Login OAuthは実装済みだが、ライブ疎通は未実施。

## 結果・成績

結果下書きは発走後に全出走馬を揃えて保存し、revision不一致を409で拒否する。取消・除外を含む公開買い目には明示的なREFUND行が必要。確定処理は同じ下書きrevisionの再送に元の結果を返し、訂正は次の結果版として追記する。

確定結果版、公開予想版別成績、買い目別精算は更新・削除・TRUNCATE・確定後の子データ追加をDBで拒否する。公開集計は`VERSION_AUDIT_V1`の参考値で、各レースの最新結果版と全公開予想版を使う。見送りとレース中止は的中率・回収率から除外する。

予想公開を停止すると公開前確認と確定を403 PREDICTION_PUBLICATION_STOPPED、CSV取込を停止するとプレビューと確定を403 CSV_IMPORT_STOPPEDで拒否する。確認後に停止した場合も確定時に再検証する。新規購入とLINE通知のフラグは後続処理が実行直前に参照するための設定で、現時点では外部処理を開始しない。

## レース管理

以下は全てADMIN+AAL2またはOPERATOR。一覧はpage/limit（既定1/20、最大50）。データ定義はpackages/domain/src/races.tsと[CSV仕様](CSV_IMPORT.md)を参照。

| Method | Path | 入力・動作 |
| --- | --- | --- |
| GET / POST | /admin/race-days | 一覧 / `{day:{raceDate,venue},reason}` |
| POST | /admin/races/:id/announce | ADMIN+AAL2またはOPERATOR。理由必須。告知版と無料LINE通知eventを追記 |
| GET | /admin/free-reports/races | ADMIN+AAL2またはOPERATOR。開催日別の無料速報進捗 |
| GET/PATCH | /admin/free-reports/races/:raceId[/draft] | ADMIN+AAL2またはOPERATOR。出走馬・下書き・公開履歴の取得／revision付き下書き保存 |
| POST | /admin/free-reports/races/:raceId/publish | ADMIN+AAL2またはOPERATOR。発走前速報または結果確定後の検証を追記公開し通知eventを作成 |
| POST | /admin/free-reports/audio | ADMIN+AAL2またはOPERATOR。8MB以下の検証済み音声バイナリを追記保存 |
| GET/PATCH | /admin/free-reports/benefit | ADMIN+AAL2またはOPERATOR。登録特典動画の固定1枠を取得／更新 |
| GET | /me/free-benefit | ログイン会員。設定済みの登録特典を返す |
| GET | /races/:raceId/free-report | ログイン会員。追記済み無料速報とレース後検証を返す |
| GET | /free-report-audio/:audioId | 公開前は管理担当、公開後はログイン会員。Range対応で音声を返す |
| GET/POST | /admin/publication-schedules | ADMIN+AAL2またはOPERATOR。開催日別の予約・警告・公開版別配信結果取得／告知または無料速報の予約作成 |
| POST | /admin/publication-schedules/:scheduleId/cancel | ADMIN+AAL2またはOPERATOR。待機中の予約を理由付きで取消 |
| GET | /admin/race-experts | 有効な専門家のid/displayNameのみ |
| GET | /admin/races | date（既定JST当日）、page/limit |
| GET | /admin/races/:id | 出走馬・担当者・revisionを含む詳細 |
| POST | /admin/races | `{race,reason}` |
| PATCH | /admin/races/:id | `{race,revision,reason}`。照合キー変更不可 |
| POST | /admin/races/:id/entries | `{entry,revision,reason,entryId?}`。編集時はentryId必須 |
| POST | /admin/races/import/preview | `{kind:races\|entries,csv,raceId?}`。出走馬のみraceId必須 |
| POST | /admin/races/import/:batchId/confirm | `{reason}`。プレビューした本人のみ |

手動作成・更新にはIdempotency-Key UUIDが必須。同一操作者・操作・キーの再送は元の結果、異なる内容は409。CSV確定はbatchId自身で冪等化し、同時再送でも取込と監査は一度のみ。

プレビューは本体を変更せず、行・列のerrors、追加/変更/変更なしのchanges（before/after）、batchId、expiresAtを返す。エラーがあればbatchId=null。確認後の変更は409 STALE_PREVIEW、15分経過は409 PREVIEW_EXPIRED、別操作者のbatchIdは404。手動編集の競合は409 STALE_REVISION。全件トランザクションで適用し、CSVにないデータを削除しない。発走時刻変更の監査を残し、公開時には最新時刻を使って締切を再検証する。

## 評価入力

担当EXPERT+AAL2またはADMIN+AAL2。EXPERTはDB上の担当レースだけを操作できる。

| Method | Path | 動作 |
| --- | --- | --- |
| GET | /expert/races/:raceId/assessments | レースrevision、全出走馬、現在の評価を馬番順で返す |
| POST | /expert/races/:raceId/entries/:entryId/assessment | `{content,revision,raceRevision,horseId,mutationId,reason}` を部分入力として保存 |
| GET | /expert/races/:raceId/entries/:entryId/history | 追記履歴。page、20件単位 |

contentは事前点数・順位・印・短評、パドック5項目、総合変化、短評。未入力はnull、パドック項目の判断不能は0。mutationIdは馬ごとの送信を冪等にし、同じIDで内容が異なる再送は409。評価revisionの不一致はASSESSMENT_CONFLICT、レースrevision・馬IDの不一致はRACE_CHANGED。競合応答に他端末の内容は含めず、認可済みGETで最新値を再取得する。成功ごとに評価履歴と監査を同じトランザクションへ追記する。

## 最終予想・公開版

編集系は担当EXPERT+AAL2またはADMIN+AAL2。EXPERTはDB上の担当レースだけを操作できる。公開済みの内容は更新せず、訂正時も新しい版を追加する。

| Method | Path | 動作 |
| --- | --- | --- |
| GET | /expert/races/:raceId/prediction | 下書き、revision、公開履歴、出走馬と現在評価を返す |
| POST | /expert/races/:raceId/prediction/draft | `{draft,revision,raceRevision,mutationId,reason}` を部分保存 |
| POST | /expert/races/:raceId/prediction/preview | `{predictionRevision,raceRevision,correctionReason}`。公開可否、警告、合計金額、15分有効のpreviewIdを返す |
| POST | /expert/races/:raceId/prediction/publish/:previewId | 本人の有効なプレビューを再検証し、公開版・凍結印・買い目・監査・通知イベントを一括保存 |
| GET | /races/:raceId/prediction | 公開履歴を新しい版から20件単位で返す。page指定可 |

下書き保存のmutationIdはUUIDで、同一操作者・レース・ID・内容なら元の結果を返し、内容が異なる再利用は409。revision不一致はPREDICTION_CONFLICT、raceRevision不一致はRACE_CHANGED。クライアントが送るroleや公開者は受け付けない。

公開時は公開範囲、信頼度、勝負判断、総評が必須。見送り以外は本命を1頭要求する。見送りは買い目を持てない。買い目は券種ごとの頭数、重複、同一馬、出走状態、100円単位の金額を検証する。プレビュー後に担当、レース、出走馬、評価、下書き、公開履歴が変わった場合は409 STALE_PREVIEWとなる。

発走時刻以降、またはFINISHED/CANCELLEDのレースは公開不可。APIの事前検証に加え、PostgreSQLトリガーが最新の発走時刻と状態を参照して公開版INSERTを拒否する。`DELAYED_PUBLICATION_POLICY` の開発既定値は `CLOSED`、`LATEST_STARTS_AT` は検証用。訂正は理由必須で、`CORRECTION_POLICY` の開発既定値は `ADMIN_ONLY`。どちらも本番前の事業判断が必要。

FREE版は未認証でも本文を取得できる。PAID版は対象JST日を含む有効期間のMEMBER権限、担当EXPERT+AAL2、またはADMIN+AAL2にだけ本文、印、買い目、評価スナップショットを返す。それ以外には版番号、公開時刻などのメタデータだけを返し、`locked=true` とする。公開範囲は履歴の各版で独立して判定し、FREE版とPAID版が混在しても別の版の権限を流用しない。ロック中は訂正理由も返さない。

公開版、凍結印、買い目はDBトリガーでUPDATE、DELETE、TRUNCATEを拒否する。印・買い目のINSERTも公開版作成と同じDBトランザクション内だけ許可する。通知イベントは `QUEUED` で保存するが、外部送信はPhase 3の対象。
