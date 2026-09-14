# Phase 6C Stripe管理設定

## 実装範囲

- 管理画面でStripe Secret key、Webhook secret、テスト／本番モード、3プランのPrice IDを設定
- Secret keyとWebhook secretをAES-256-GCMで暗号化して保存
- 設定取得API、監査ログ、画面には秘密値を返さず、設定済み・復号可能だけを表示
- Secret keyのtest/live接頭辞と選択モードを照合
- 部分設定、不整合、本番でのテストモードではStripe購入を開始しない
- 管理画面設定を環境変数より優先し、既存環境では環境変数を互換用フォールバックとして利用
- 管理者だけがAAL2完了後に変更でき、revision競合と変更理由を既存の設定監査へ記録

## 運用境界

`BILLING_TRANSPORT` は配備時の安全スイッチとして環境変数に残す。管理画面へStripe情報を保存しただけでは外部決済へ切り替わらない。本番ではさらに環境変数 `STRIPE_LIVE_MODE=true` を必要とし、DB側も本番モードかつライブSecret keyでなければ購入とWebhook処理を開始しない。

Stripe設定を管理画面へ1項目でも保存すると、その一式を設定元として扱う。環境変数とDBの資格情報を混在させない。環境変数から移行するときは、Secret key、Webhook secret、3つのPrice IDをまとめて保存する。

## 未対応

資格情報のライブ疎通、Webhook endpointの自動登録、Stripe Priceの金額照合テスト、本番決済は実施していない。秘密値ローテーション時は旧Webhook secretとの切替時間を運用計画で定める。
