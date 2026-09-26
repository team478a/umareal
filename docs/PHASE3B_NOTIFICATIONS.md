# Phase 3B 通知運用の実装結果

2026年9月12日。最終予想の公開outboxから、宛先判定、配送試行、再試行、管理画面での監視と手動再送までをローカル実装した。

## 実装範囲

- 公開イベントを受信者単位のLINE配送へ冪等に展開
- 通知設定、アカウント状態、有料閲覧権限を送信直前にも再確認
- `FOR UPDATE SKIP LOCKED` とリースによる同時ワーカーの重複防止と停止回復
- 一時失敗の指数バックオフ、最大試行回数、恒久失敗分類
- DBで追記専用に保護した配送試行履歴
- `/admin/notifications` の状態集計、フィルター、履歴、理由付き手動再送
- `GET /admin/notifications` の公開応答をAPIとWebで共有する厳格なContract
- LINE通知の全体停止時にoutboxを保持
- ローカルtest transportと本番起動拒否

## この区間に含まないもの

LINE Messaging APIへの外部送信、資格情報の疎通確認、Webhook、LINE Login、決済、結果・成績、本番配備は未実装。test transportは識別子だけを受け取り、予想本文、印、買い目を扱わない。
