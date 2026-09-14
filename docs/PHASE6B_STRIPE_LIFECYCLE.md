# Phase 6B Stripe継続課金ライフサイクル

## 実装範囲

- `invoice.paid` による初回請求期間の補正、月額更新、失敗後の回復
- `invoice.payment_failed` による支払失敗履歴、PAST_DUE、設定済み猶予期限の反映
- `customer.subscription.updated` による解約予約・予約解除の同期
- `customer.subscription.deleted` による契約終了と閲覧権限の失効
- StripeイベントID、Invoice IDのロックと追記専用履歴による重複反映防止
- 会員画面・管理画面で支払猶予期限とWebhook管理状態を表示

## 状態と権限

初回のCheckout完了後、Stripeの初回請求イベントで実際の請求期間へ補正する。更新成功時はStripe Invoiceの期間を契約と有限期間entitlementへ反映する。失敗時は支払済み期間の終了から管理設定の日数だけ猶予し、同じPAST_DUE中の再失敗で期限を延長しない。その時刻を過ぎると既存のサーバー側権限判定で本文取得を拒否する。回復時は新しい請求期間でACTIVEへ戻す。契約終了イベントではentitlementを即時失効する。

ブラウザーや管理画面からStripe契約を成功・失敗状態へ変更できない。外部決済モードの状態遷移は署名済みWebhookだけを根拠にする。ローカル失敗・回復操作は `BILLING_TRANSPORT=test` のみに限定する。

## 未対応

ライブ資格情報による疎通、本番請求、正式な猶予日数・督促手順、返金、クーポン、無料期間、プラン変更、領収書導線は未対応。支払失敗・回復・解約の会員向けLINE通知も後続フェーズで実装する。
