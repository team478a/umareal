# AIレースガイド 実データBackfill・更新設計

作成日: 2026-10-05
状態: 設計のみ。取得・backfill・migrationは実行しない。

## 開始Gate

次を満たすまで実データ処理を開始しない。

1. providerとの契約でStorage、Derived、Display、retention、correctionが書面承認されている。
2. 対象fieldごとの`DataLicensePolicy`案を法務・事業責任者が承認している。
3. 最新SDK/仕様版、dataspec、record type、提供期間を実端末資料と照合している。
4. source recordからFactまでの永続provenance設計が承認されている。
5. stagingのsynthetic/licensed sampleでdry-run、resume、訂正を検証している。

## 初回backfill範囲

- 対象: UMAREALで実際に掲載する今後の対象レースの出走馬だけ
- 期間: 各馬の直近24か月
- 件数: 各馬最大10走
- レース: 中央平地の芝・ダート。現行bridgeの対応範囲を超えない
- 除外: 全JRAデータ、全競走歴、血統、調教、時系列オッズの一括取得

全データを先に集めず、対象レース単位のon-demand backfillを採用する。RCOV/RCVN等の提供単位がレース週単位の場合は、そのdeliveryを1 source batchとして受け取り、保存対象は契約で許可されたV1 fieldへ絞る。

## Batchとresume

- logical batch: `provider + dataspec + delivery/revision + target race/date`
- processing chunk: 25頭を初期上限とする。ただしprovider呼出単位や契約上限を優先し、25頭ごとの外部requestを意味しない
- cursor: source artifact番号、record offset、最後に確定したlogical keyを保持
- checkpoint: parse、normalize、license gate、persist、coverage集計ごとに記録
- resume: 完了checkpointの次から再開し、同一recordを再処理しても結果を重複させない
- resource control: 1 collector、1 importerを既定とし、CPU・disk・DB負荷とprovider制限を確認してから変更

具体的なrate、同時数、実行時刻は契約・端末・運用要件確定前に固定しない。

## Idempotency

正規化recordの冪等key候補:

```text
provider
+ dataspec / record kind
+ provider logical record key
+ provider data-created-at / revision
+ normalized payload hash
```

- 同一key・同一hash: no-op
- 同一logical key・新revision/hash: 新しいsource observationを追加
- 同一revision・異なるhash: conflictとして停止し、人が確認
- provider deletion record: 物理削除せず、取消observationを追加。契約上削除義務がある場合は別の承認済み消去手順へ送る

現行`ImportBatch`は短時間のCSV preview用途で、provider/dataspec/revision/record cursor/completenessを永続保持しない。Phase 1C-2では、既存tableへ意味を混ぜず、additiveな`SourceImportBatch`/`SourceRecordObservation`相当をmigration候補として設計する。

## Provenance必須項目

- provider、contract/policy version
- dataspec、record kind、SDK/spec version
- source delivery/batch IDまたは許可されたhash
- source record reference（raw keyは禁止ならhash）
- provider data-created-at/revision/data division
- observedAt、importedAt、dataCutoffAt
- normalized schema version、normalizer version、logic version
- source artifact hash、normalized payload hash
- completeness statusと理由

raw recordを保存するか、いつ削除するかはcontractに従う。hashだけでは訂正内容を再現できないため、raw非保存契約の場合は許可された正規化snapshotとfield-level evidenceを保持する。

## Partial failure

- 1 recordのvalidation failureでbatch全体を公開可能にしない
- 正常recordはstagingへ保持できるが、coverageは`PARTIAL`
- retryable: 一時I/O、COM busy、DB接続、checksum取得失敗
- non-retryable: 未知record版、license拒否、不正key、同revision異hash、cutoff違反
- retryは指数backoffと上限を設定し、無限再試行しない
- failure code、件数、最後のcheckpointをauditへ記録し、raw本文・利用キーは記録しない

## Incremental Update

時刻ではなくイベント境界で設計する。

| 境界 | 対象 | 処理 |
| --- | --- | --- |
| 出走情報公開後 | RA/SE、関連過去走 | 新規target race作成、identity照合、V1 backfill |
| 枠順・騎手等更新後 | RA/SE/変更record | source revision追加、Fact input hashを再計算 |
| 当日開催情報更新後 | WE、取消・除外、必要ならWH | 現在条件更新。V1必須以外はfeature別gate |
| ガイド生成直前 | 必須source | cutoffを固定し、completeness/licenseを再検証 |
| レース結果確定後 | RA/SE result | 新`RaceResultVersion`候補。事前Factへ混入させない |
| provider訂正検知後 | 該当record | source revision追加、依存guideを`STALE`候補にする |

具体時刻はJRA-VAN/JRADBの契約上の配信時刻とUMAREAL運用会議で決める。コードに推測時刻を埋め込まない。

## RevisionとAI Guide

```text
source revision追加
  → normalization/provenance検証
  → 旧input hashとの差分判定
  → 依存する未公開generationをSTALE
  → 管理者へ再生成候補を提示
  → 新generation・検証・承認
  → 必要な場合だけ新しい公開version
```

公開済み`AiRaceGuideVersion`と`RaceResultVersion`は上書きしない。訂正後も当時のcutoff/sourceVersion/inputHashを再現可能にする。

## Completeness確認

batch終了時に次をmanifest化する。

- expected/received/accepted/rejected count
- target horse/race count
- requested windowと最古・最新record日
- zero-history confirmed count
- missing required field count
- unresolved identity count
- license-denied field count
- correction/conflict count
- checksumとnormalizer version
- `COMPLETE / PARTIAL / UNKNOWN`およびreason codes

manifestが`COMPLETE`でもFact sampleが少なければ`INSUFFICIENT_DATA`になる。両者を別に保存・表示する。

## Rollback

- import observationはappend-onlyとし、誤batchを無効化するreversal observationを追加する
- 公開済みguideは維持し、影響版を管理者へ表示する
- importer停止flagを独立させる
- 新sourceを止めても既存パドック・WIN5・レース紙面・結果を継続できることを必須とする
