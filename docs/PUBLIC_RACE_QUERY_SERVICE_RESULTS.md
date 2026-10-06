# 公開レース閲覧Query Service分離 結果

## 目的

公開レース一覧と対象レース告知一覧の読み取りを`AppController`から専用Query Serviceへ移す。外部仕様、公開条件、画面、通知処理は変更しない。

## 基準

- 基準main: `0fb2fac`
- 作業branch: `refactor/public-race-query-service`

## 実装

- `PublicRaceQueryService.list`へ開催日・期間・競馬場・キーワード・公開・結果条件、ページング、会場候補、最新告知・予想・結果メタデータの取得と投影を移した。
- `PublicRaceQueryService.announcements`へ公開時刻、発走6時間境界、中止除外、レース単位の最新版選択、最大10件の投影を移した。
- Controllerには`publicRaceListQuerySchema`による既存入力検証を残した。
- Raceの取得を明示的なselectへ変更し、予想本文、評価snapshot、担当者、出走馬、内部source情報を取得しない。
- RaceAnnouncementはID、Race ID、版、公開日時、公開レース基本情報だけを取得し、理由と公開者を取得しない。

## 非変更範囲

- API URL、query parameter、応答Contract
- JST既定日、期間上限、検索条件、ページング、並び順
- 告知の公開条件、6時間境界、最大件数
- 公開・通知・予想・結果の書き込み処理
- Web画面、DB schema、migration、既存データ
- 本番環境

## 検証結果

- Query Service unit: 2件成功
- race discovery / announcement publication integration: 15件成功
- 全unit: 87 files / 477 tests成功
- 全script test: 20 tests成功
- typecheck: 全5 workspace成功
- lint: 成功（warning 0）
- production build: API / Web / Worker成功
- 公開レース履歴検索E2E: desktop / mobile各1件成功

## 判定

GO。Query Service分離による公開条件・検索結果・画面表示の変更はなく、DB migrationと本番デプロイも不要である。
