# 手動運用の監査・訂正 Phase 3 実装結果

作成日: 2026-10-06

## ゴール

JRA-VAN未接続の手動運用で、レース単位の入力・公開・結果操作を追跡し、誤って確定した暫定Horse Identityを過去データを壊さず訂正できるようにする。

## レース操作履歴

- レース編集画面に対象レースの操作履歴を追加した。
- Race自身、RaceEntry、RaceAnnouncementへの操作に加え、監査詳細に同じ`raceId`を持つ評価、予想、結果、AIガイド等を取得する。
- 操作、取得方式、担当者名・ロール、理由、JST日時を表示する。
- 取得方式は`MANUAL`、`CSV`、`JRA_VAN`、`UMAREAL`へ分類する。
- API応答に監査詳細のJSON全体は含めず、必要な表示項目だけを返す。

## Horse Identity訂正

- 確認済みの`MANUAL` Identityと、初回確認・訂正履歴をレース管理画面から確認できる。
- 訂正は`ADMIN+AAL2`限定で、同名Horseだけを訂正先に選択できる。
- 訂正理由、冪等性キー、現在Horse ID、現在更新時刻を必須とし、古い画面からの上書きを拒否する。
- 訂正時は`HORSE_IDENTITY_CORRECT`をAuditLogへ追記する。以前の確認・訂正ログは更新・削除しない。
- `RaceEntry.horseId`、Assessment、Prediction、公開版、結果は変更しない。

## 境界

- DB migrationなし。
- JRA-VAN追加取得なし。
- 外部AI通信なし。
- 自動Horse mergeなし。
- 本番deploy / 本番migrationなし。

## テスト対象

- 初回確認後の履歴取得。
- 管理者による訂正と追記監査。
- stale訂正の拒否。
- OPERATORによる訂正の拒否。
- 既存RaceEntryが訂正で変わらないこと。
- レース単位履歴と取得方式の表示用contract。
