# Phase 3C LINE本接続準備の実装結果

2026年9月12日。LINEへ通信せずに確認できる通知文、資格情報診断、Webhook署名検証を実装した。

## 実装範囲

- LINE通知transportへ渡すテキストメッセージの共通ビルダー
- 初回送信から同じUUIDを渡す `X-Line-Retry-Key` 用transport契約
- 有料予想の印、馬番、買い目、評価理由、金額を通知文へ含めない構造
- HTTPS会員ページURL、文字数、レース表示値の改行除去
- 生リクエスト本文を使うHMAC-SHA256 Webhook署名検証部品
- 管理画面での資格情報保存、復号、URL、ワーカー、署名検証の準備状況表示
- test transportと本番拒否の既存境界を維持

## 次区間に残すもの

Messaging APIの外部疎通、push API transport、公開Webhookエンドポイント、follow/unfollowイベント処理、LINE Loginのstate/nonce/PKCEとOAuth Callback、実アカウントを使う結合試験は未実装。これらは外部LINE通信を許可した区間として別に実施する。
