# Phase 6N 無料会員募集モード

## 実装範囲

初回公開でLINEまたはメールによる無料会員募集を開始できるよう、公開機能と外部transportを分離する。2026年10月2日の「無料会員にもLINE配信は行う」指示により、無料募集時のLINE通知停止方針を変更した。

- `FREE_REGISTRATION` はLINE登録・ログイン、メール登録・確認・ログイン、会員ページ、Webお知らせ、無料情報を有効にする。
- 同モードではLINE・メールの公開通知を有効化できる。Stripe購入は引き続き画面とAPIの両方で停止する。LINE連携済みで受信可能な無料会員へ対象レース告知、無料速報、WIN5・通常紙面の公開通知を送れる。有料予想本文や具体的な馬番は通知へ含めない。従来PAID指定のパドック通知の対象は変更しない。
- 本番APIのLINE OAuthは `line`。APIとworkerの `NOTIFICATION_TRANSPORT` は `disabled` または `line` を許可し、開発用 `test` は拒否する。銀行振込を別承認で開始するまでは`BILLING_TRANSPORT=disabled`を維持し、開始時は`bank_transfer`と管理画面の受付Gateを使用する。
- `disabled` のworkerはLINE資格情報を読み込まず、通知eventを `SKIPPED` に確定してLINE配送を作らない。予約公開、メール配送、Web内お知らせは継続する。`line` 有効化時も過去の展開済みeventを巻き戻さない。`line`では既存Messaging API transport・既存配信対象判定を再利用する。
- 管理画面のLINE通知スイッチ、本人の通知カテゴリ、ブロック・連携解除・退会状態を維持する。公開設定APIの `capabilities.lineNotifications` は提供可能な機能、`lineNotificationsEnabled` はAPI側transportと管理スイッチが有効な状態を示す。実送信成功は保証せず、workerの稼働と配送履歴を別途確認する。
- 管理画面の本番準備チェックはLINE設定不足を表示し、担当者本人へのテスト送信を案内する。無料募集モードだから対象外とは表示しない。Stripeは引き続き対象外。
- 告知・無料速報の配信前確認では、API側の通知transportが停止中ならLINEの送信予定数を0件にする。対象になり得る人数は別に表示し、メールの予定数を維持する。
- `FULL` は従来どおり、本番LINE transport、LINE OAuth、Stripe transport、Stripe live modeを必須にする。

## 安全条件

本番では `LAUNCH_MODE` の明示を必須にし、未知の値を拒否する。公開モードで無効な機能は画面を隠すだけでなく、LINE OAuth開始・コールバック・登録・解除、LINE Webhook、Stripe Checkout・WebhookをAPI側でも拒否する。

初期Render Blueprintは `FREE_REGISTRATION` とし、`LINE_OAUTH_TRANSPORT=line`、LINE通知とStripeの初期値を`disabled`に維持する。コード反映だけで実会員への通知を開始しない。`FULL`は従来の本番LINE・Stripe要件を維持し、クラウド試験モードの本番LINE通知は引き続き停止する。本番DB変更は不要。

## 本番で有効にする手順（コード納品とは別工程）

1. 管理者+AAL2が `/admin/settings` にMessaging APIのChannel ID、Channel secret、Channel access tokenを保存する。LINE Loginとは別の設定である。
2. 配信キュー、対象会員、本人の受信設定、Webhook設定を確認する。未展開event・再試行待ち配送があれば、送信対象を確認してから有効化する。過去の `SKIPPED` eventは再送しない。
3. APIとworkerを今回の同じリリースへ更新し、両方の `NOTIFICATION_TRANSPORT=line` を設定する。`LAUNCH_MODE=FREE_REGISTRATION`、`BILLING_TRANSPORT=disabled`、`STRIPE_LIVE_MODE=false` は維持する。管理画面の「LINE通知」も有効にする。
4. 管理者本人のLINE連携・二段階認証を確認し、通知運用の「通知接続確認（対象不要）」から本人へのテスト送信を行う。レースや予想が未登録でも実行でき、送信対象は本人だけで、公開、通知event、会員配送を作らない。
5. 無料会員向け告知・無料情報・紙面を公開し、 `/admin/notifications?channel=LINE` で配送結果を確認する。本文の閲覧制限は既存アクセス判定を維持する。

ライブテスト・設定切替・会員配信は対象と時間を確認した別工程で実施する。

## 検証

- `pnpm test`：無料募集のLINE capability、停止状態の公開設定、モード別の本番transport許可、課金停止、Webhookのモード境界。
- `node scripts/check-production-guard.mjs`：コンパイル済みAPI/workerのFREE+line起動境界と本番test拒否。ローカルDB所有者の既存ガードで止め、外部サービスへ接続しない。
- `pnpm test:integration:free-line`：APIをローカルFREEモードで起動して実行。無料会員への告知、受信拒否・退会の除外、冪等配送、ADMIN+AAL2の本人テスト、WIN5・通常紙面の本文非公開、通知停止時の過去event非再送。全体の回帰試験でも同じ既存テストを実行する。
- `notification-test-send.integration.test.ts`：レース、予想、契約がない初回稼働でも、ADMIN+AAL2が本人だけへ固定文面の接続確認を送れ、通知eventと会員配送を作らず監査ログを残すことを確認する。
- `pnpm exec playwright test tests/e2e/race-papers.spec.ts`：FREEモードでもPC・スマートフォン幅の紙面公開・閲覧・通知プレビューを確認する。

本番LINE到達・Webhook到達・実機LINE内ブラウザの確認はローカルシミュレーションやCIのPASSと区別する。
