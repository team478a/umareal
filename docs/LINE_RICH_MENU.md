# LINEリッチメニュー V1

## 目的

LINE公式アカウントのトーク画面から、会員がウマリアルの主要画面へ移動できる固定メニューを提供する。管理者はアプリ内で完成画像と移動先を確認し、理由を入力して明示的に公開する。登録、予想公開、通知などの操作をリッチメニュー公開へ連動させない。

## V1のメニュー

画像はサーバーが2500×1686pxのPNGとして生成する。LINEの各タップ領域と画像上の配置は同じ定義から作り、次の6項目に固定する。

| 表示 | 移動先 | 用途 |
| --- | --- | --- |
| 登録特典 | `/benefit` | LINE登録特典動画 |
| WIN5紙面 | `/win5` | 前日のWIN5紙面 |
| レース一覧 | `/races` | 公開レース |
| お知らせ | `/notifications` | 告知と公開情報 |
| 料金プラン | `/plans` | プランと料金 |
| マイページ | `/account` | 会員情報と設定 |

URLは`APP_BASE_URL`からサーバーが生成する。管理画面から任意URL、任意画像、スクリプトを入力する機能は持たない。未ログインで保護画面を開いた場合、ログイン後は許可済みの元画面へ戻す。外部URLや自由入力の戻り先は受け付けない。

## 管理と権限

`/admin/line-rich-menu`と対応APIは`ADMIN + AAL2`だけが利用できる。管理者は次を順に行う。

1. 生成済み画像を確認する。
2. 6つの移動先を確認する。
3. 確認チェックを入れ、公開理由を入力する。
4. 公開ボタンを押す。

`LINE_RICH_MENU_TRANSPORT=test`ではDB履歴と画面だけを確認する模擬公開になる。`line`では管理設定に暗号化保存したMessaging API Channel access tokenを使用する。`disabled`では公開できない。未設定の既存環境だけは`NOTIFICATION_TRANSPORT`へ後方互換でフォールバックする。通知配送を停止したままメニューだけを公開できるが、クラウドテストモードから実LINEへの公開は起動時に拒否する。アクセストークンはAPI、画面、監査、ログへ返さない。

## LINEへの公開順序

1. Rich Menuオブジェクトを新規作成する。
2. PNG画像をアップロードする。
3. 新しいメニューを全ユーザーの標準メニューに設定する。
4. 成功履歴と監査を保存する。

LINEでは公開済みメニューの画像を直接置換できないため、変更は常に新規メニューとして作る。標準設定に成功するまでは現在の標準メニューを変更しない。作成後に画像登録または標準設定が失敗した場合は、新しく作った未使用メニューだけを削除し、従来メニューを維持する。外部成功後のDB障害など、完全に自動回復できない例外は監査・運用確認の対象とする。

## データと同時実行

`line_rich_menu_publications`は公開試行ごとに次を保持する。

- `PUBLISHING / PUBLISHED / FAILED`
- LINE側Rich Menu ID（成功時のみ）
- 公開時の領域・移動先スナップショット
- PNGのSHA-256とバイト数
- 実行理由、実行管理者、UTC時刻、失敗コード

完了行はPostgreSQLトリガーで更新・削除を拒否する。進行中はDB上で1件だけとし、画面が確認した最新公開IDも照合する。5分を超えた進行中処理は次の管理操作時に失敗として閉じる。現在の公開記録は完了時刻が最新の`PUBLISHED`行とする。

## 監査

- `LINE_RICH_MENU_PUBLISHED`
- `LINE_RICH_MENU_PUBLISH_FAILED`

`targetType`は`LINE_RICH_MENU`とする。理由、transport、LINE側メニューID、画像SHA-256、失敗コードだけを記録し、資格情報は記録しない。

## API

- `GET /api/v1/admin/line-rich-menu`
- `GET /api/v1/admin/line-rich-menu/preview`
- `POST /api/v1/admin/line-rich-menu/publish`

公開リクエストは、画面で確認した`currentPublicationId`（未公開なら`null`）と理由を必須にする。

## 運用確認

コードとローカル試験では生成画像、権限、AAL2、同時公開、履歴保護、LINE API呼出順、失敗時の新規メニュー削除を確認する。本番公開前に人が次を確認する。

- LINE DevelopersでMessaging APIの権限と長期Channel access tokenが有効
- 管理設定へ正しいtokenが暗号化保存済み
- 独自ドメインの`APP_BASE_URL`がHTTPSで正しい
- 実LINE公式アカウント上で画像、6領域、各遷移先が正しい
- iPhone/AndroidのLINE内ブラウザーでログイン後に元画面へ戻れる

本番tokenを用いた接続試験と本番公開は、別の明示承認を得て行う。

## V1で行わないこと

- 会員ごとのメニュー出し分け、タブ切替、リッチメニューエイリアス
- 管理者による自由なレイアウト・画像・URL編集
- AIによる画像生成
- 登録や予想公開に連動した自動公開
- 古いLINE側メニューの一括削除

## 参考

- [Use rich menus](https://developers.line.biz/en/docs/messaging-api/using-rich-menus/)
- [Rich menu overview](https://developers.line.biz/en/docs/messaging-api/rich-menus-overview/)
- [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)
