# AIレースガイド データモデル（Phase 1B）

作成日: 2026-10-05

## 原則

- 正本は既存の `Race`、`Horse`、`RaceEntry`、`RaceResultVersion` とし、AI専用の過去走コピーを作らない。
- 事前Factへ `Assessment`、`AssessmentVersion`、`Prediction`、`PredictionVersion`、三国谷コメント、会員・管理者情報を入れない。
- 結果訂正は `RaceResultVersion` の版を保持し、`dataCutoffAt` 以前に確認できた最新版だけを使用する。
- 新規テーブルは補助情報に限定し、全てadditive migrationで追加する。

## V1データ分類

### A：V1必須

| 区分 | 項目 | 現在の正本 | 判定 |
| --- | --- | --- | --- |
| レース | 開催日、場、番号、名称、芝/ダート、距離、回り、馬場、発走、頭数 | `Race` | 構造あり。source/field別権利登録が必要 |
| 出走馬 | Horse ID、名称、馬番、枠、性齢、斤量、騎手、調教師 | `Horse` / `RaceEntry` | 構造あり。source/field別権利登録が必要 |
| 過去走 | 開催日、場、芝/ダート、距離、馬場、着順、人気、単勝 | `Race` / `RaceEntry` / `RaceResultVersion.entriesSnapshot` | 取込済みレースのみ。網羅性は未保証 |
| 境界 | result confirmedAt、observedAt、importedAt、data cutoff | result版 / provenance | Phase 1Bでcontract化 |

### B：V1任意

| 項目 | 保存方針 |
| --- | --- |
| 馬体重・増減 | `RaceEntryPerformance` のnullable拡張値 |
| 走破時計・着差・上がり・通過順位 | `RaceEntryPerformance`。結果版ごとに保存し訂正履歴を保持 |
| 脚質参考 | 上記の許諾済み事実から将来決定計算。推測値は保存しない |
| 血統 | Phase 1Bではsynthetic contractのみ。本番取得・保存は未実装 |

### C：将来

- 調教、追切
- 時系列オッズ
- 高度な血統統計
- 騎手・調教師高度分析
- 独自予測特徴量

これらは取得量を増やす目的では導入せず、商品要件・権利・保持期間を確認した別Phaseで扱う。

## Horse Identity

`Horse.id`をUMAREAL内部の正本とする。JRA-VAN bridgeが血統登録番号から生成する決定的UUIDは維持するが、血統登録番号そのものは保存しない。

`HorseExternalIdentity`は以下のみを保持する。

- provider
- 許可された外部キーのSHA-256（`externalKeyHash`）
- source version
- 観測名
- `MATCHED` / `POSSIBLE_DUPLICATE` / `UNRESOLVED`
- 初回・最終観測時刻

provider + hashは一意かつ更新不可。名前一致だけの場合は `POSSIBLE_DUPLICATE` とし、自動merge・Horse削除を行わない。確定は人間の確認を必要とする。

## 現在のJRA-VAN bridge再監査

- RAは開催日、場、R、名称、発走、クラス、距離、surface、direction、going、weatherを既存Race CSVへ正規化する。
- SEは馬番、枠、馬名、性齢、斤量、騎手、調教師、オッズ、人気、異常区分、着順を既存Entry/Result CSVへ正規化する。
- 血統登録番号はbridge内でUUID v5生成にだけ用い、CSV、manifest、DBへ保存しない。
- APIはRA/SE固定長recordを直接受け取らず、preview・確認・監査を通す。
- 現在の保存範囲でAIに使える過去走はUMAREALへ取込済みのRace/Entry/Resultだけで、網羅的な過去走ではない。
- 走破時計、着差、上がり、通過順位、馬体重、血統、調教、時系列oddsは現bridgeのAI V1保存対象に含まれない。

追加record取得、ライブ疎通、backfillは実装していない。上記未取得項目は技術調査と利用許諾の両方が必要である。

## 過去走と任意拡張値

基本結果は `RaceResultVersion.entriesSnapshot` を読み、同一raceについてcutoff以前に確定した最大versionを採用する。

`RaceEntryPerformance`は正本結果を複製せず、現在保存先のない次の任意値だけを結果版・出走馬へ関連付ける。

- finishTimeMs
- marginText
- finalSectionTimeMs
- bodyWeightKg / bodyWeightChangeKg
- cornerPositions
- source provider/version/record reference
- observedAt / importedAt
- license policy

結果訂正時は別の `RaceResultVersion` に別行を追加する。行はPostgreSQLでUPDATE/DELETE/TRUNCATEを拒否する。

## Provenance

FactのEvidenceは最低限、`sourceProvider`、`sourceKind`、`sourceVersion`、`sourceRecordReference`、`observedAt`、`importedAt`、`dataCutoffAt`、`logicVersion`を持つ。raw dataの無期限保存を意味せず、referenceは契約上保存可能な値またはhashを使用する。

## Assessment改善案

既存 `Assessment.content.calm` は変更・削除しない。将来は後方互換な新revisionのcontent schemaとして、次を追加する案とする。

- `sweating`: 発汗だけを表すnullable評価
- `calmness`: 落ち着きだけを表すnullable評価
- 旧 `calm`: 過去版の読取互換用に維持

旧値から2項目を自動推定・backfillしない。入力UI、評価不能と未入力の区別、分析開始versionを別Phaseで承認する。
