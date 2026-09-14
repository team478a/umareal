# Phase 6A Stripe Checkout接続基盤

## 実装範囲

- 通常月額・創設月額のカード決済用Stripe Checkout Session作成
- 指定JST開催日の1日利用Checkout Session作成
- 申込時のUUID冪等キー、サーバー保存価格、会員・プランの固定
- Stripe署名、live/testモード、JPY金額、内部申込との照合
- Webhook確認後だけ契約、支払履歴、有限期間閲覧権限を同一トランザクションで作成
- StripeイベントとCheckoutの重複反映防止、Webhook履歴の更新・削除拒否
- 本人によるStripe月額契約の解約予約API呼出し
- 管理画面で外部決済申込とWebhook処理結果を確認

## 安全条件

ブラウザーの成功URLは決済根拠にしない。Phase 6Aでは同期して決済完了を確認できるカードに決済方法を限定する。カード情報、Webhook secret、Secret key、イベント本文はDB、APIレスポンス、ログへ保存しない。本番起動時はStripe資格情報、3つのPrice ID、liveモード、HTTPSを必須にする。

## 未対応

ライブ資格情報による疎通、本番請求、正式価格・返金条件、クーポン、無料期間、領収書、プラン変更、返金処理は未対応。月額更新、請求失敗、回復、解約・終了のWebhook同期はPhase 6Bで実装済み。
