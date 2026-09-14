# Phase 3D LINE Messaging API接続の実装結果

2026年9月12日。実送信transportと署名付きWebhook受付を実装し、外部へ通信しない模擬応答とローカル署名リクエストで検証した。

## 実装範囲

- 固定HTTPS endpointへのpush API transport
- Bearer認証、JSONメッセージ、初回から一貫したUUIDリトライキー
- 2xx、受理済み409、4xx、5xx、タイムアウト、通信断の失敗分類
- LINE側の24時間保証に合わせた自動・手動再送期限
- 未加工本文のHMAC-SHA256署名を必須にしたWebhook
- `webhookEventId` の一意制約と追記専用履歴
- follow/unfollowによる通知不可状態と時系列の逆転防止
- Webhook受信状況を通知管理画面へ表示

## 実行していないもの

保存済み資格情報のライブ検証、LINE APIへの実リクエスト、実会員への通知、本番公開は行っていない。LINE Login OAuthはPhase 3E候補として残す。
