# Phase 6N 無料会員募集モード

## 実装範囲

初回公開でLINEまたはメールによる無料会員募集を開始できるよう、公開機能を `FREE_REGISTRATION` と `FULL` の2段階に分けた。

- `FREE_REGISTRATION` はLINE登録・ログイン、メール登録・確認・ログイン、会員ページ、Webお知らせ、無料情報を有効にする。
- 同モードではLINE Messaging APIによる通知配送とStripe購入を画面から除外し、直接APIを呼ばれても拒否する。LINE Loginだけを通知配送から独立して有効にする。
- 本番APIはLINE OAuthだけが `line`、LINE通知とStripeが `disabled` であることを検査する。誤って通知配送、有料販売、開発transportを動かさない。
- workerは予約公開を継続するが、LINE資格情報を読み込まず、通知eventをWeb専用として`SKIPPED`に確定し、配送を作成しない。Web内のお知らせは公開済みeventから引き続き表示する。
- 管理画面の本番準備チェックは、無料募集モードで対象外のLINE・Stripeを準備済みとして扱い、`FULL`切替前の作業を案内する。
- `FULL` は従来どおり、本番LINE transport、LINE OAuth、Stripe transport、Stripe live modeを必須にする。

## 安全条件

本番では `LAUNCH_MODE` の明示を必須にし、未知の値を拒否する。公開モードで無効な機能は画面を隠すだけでなく、LINE OAuth開始・コールバック・登録・解除、LINE Webhook、Stripe Checkout・WebhookをAPI側でも拒否する。

初期Render Blueprintは `FREE_REGISTRATION` とし、`LINE_OAUTH_TRANSPORT=line`、LINE通知とStripeを`disabled`に固定する。LINE Loginの資格情報とCallback URLを管理画面へ保存し、実アカウントでライブ疎通を確認してから募集へ使用する。将来`FULL`へ切り替える際は、LINE通知とStripeの資格情報保存・ライブ疎通を先に完了し、APIとworkerの環境変数を同時に変更する。

## 次の機能ゴール

管理者が新規会員登録だけを理由付きで停止・再開できる運用機能を追加する。既存会員のログインと閲覧は維持し、変更を監査履歴へ残す。
