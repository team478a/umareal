# Phase 6X 管理者本人への配信テスト

## 完成条件

- 対象レース告知、無料パドック速報、レース後検証の配信前確認から、管理者本人のLINEまたは確認済みメールへ、公開時と同じ生成本文にテスト表示を加えて送信できる。
- ADMIN+AAL2だけが実行でき、宛先をクライアントから指定できない。
- チャネル停止、LINE連携解除・ブロック、メール未確認・配信拒否を送信前に拒否する。
- 無料情報は保存済みdraft revisionと公開条件をサーバーで再検証する。
- 冪等キーと理由を必須にし、宛先や資格情報を含めず成功・失敗を監査する。
- テスト送信によって公開版、会員向け通知event、配送を作らない。

## 実装

- `POST /api/v1/admin/notifications/test-send`
  - `raceId`、`contentType`、無料情報の場合は`draftRevision`、`channel`、`reason`を受け取る。
  - `Idempotency-Key` UUIDを必須とし、同じキーと本文の再実行は保存済み結果を返す。
  - 配信前確認APIと同じ検証・共通通知文面を使用する。
  - LINEは管理者本人の有効なLINE連携、メールは本人の確認済みメールだけを使用する。
  - test transportでは`SIMULATED`、有効な外部transportではProvider受理後に`SENT`を返す。
- `/admin/publication-schedules`と`/admin/free-reports`
  - 配信前確認内にLINE・メールのテスト送信ボタンを表示する。
  - 全体停止中のチャネルはボタンを無効にし、完了状態を公開・予約操作と分けて表示する。

## データ保護と運用境界

監査にはレース、内容種別、チャネル、transport、版、結果、理由だけを保存する。メールアドレス、LINE subject、アクセストークン、API key、Provider本文・識別子は保存しない。失敗時も安全なエラーコードだけを記録する。ローカルとCIはtest transportを使用するため外部へ送信しない。実LINE・Resend資格情報による疎通と端末受信確認は本番接続工程で、送信先と時刻を確定して実施する。
