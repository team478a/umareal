# AIレースガイド Phase 1C-1 監査結果

作成日: 2026-10-05
基準main: `92bc7024ebb941744081b461bdb9e6600cb4e8ec`
状態: 調査・設計のみ

## 1. Phase 1B再監査

以下がmainへ実装済みで、Phase 1C-1を止めるregressionは見つからなかった。

- `HorseExternalIdentity`と人手確認前提の重複候補
- source/field/use別`DataLicensePolicy`
- `RaceEntryPerformance`と結果versionへの紐付け
- provenance、Evidence、dataCutoffAt、logicVersion
- Future Data Leakage防止と結果訂正選択
- Synthetic Fixture A〜H
- Phase 1A StructuredInputへのallowlist projection
- Assessment、Prediction、三国谷コメント、User情報の入力拒否
- 管理者Data Coverage

## 2. 実データ導入前の不足

1. JRA-VAN Data Lab通常契約は有料会員サービスへの二次利用を許可しない。JRADB等の商用契約が必要。
2. 現行bridgeはRA/SEの一部fieldだけをCSV化し、RCOV/RCVN、WH、WE等を取得しない。
3. manifestはartifact hashを持つが、DBのRace/Entryからprovider record・作成日・import batchへ永続追跡できない。
4. provider側のdata-created-at/data division/revisionをRace/Entry provenanceとして保持していない。
5. `COMPLETE / PARTIAL / UNKNOWN`のsource window completeness contractは未実装。
6. current RaceEntryの馬体重snapshotを時点・revision付きで保存するmodelはない。

これらはPhase 1C-2候補であり、本Phaseではmigrationや取得コードを作らない。

## 3. V1決定

- 現在レース・出走馬基本情報
- 各馬の直近10走、最大24か月
- 過去走は開催条件、確定着順、異常区分を必須とする
- 現在/過去オッズ、馬体重、詳細時計は任意
- 血統はPhase 2候補
- 調教・追切はPhase 2以降

この最小構成で既存Fact BuilderのRecent Formと条件別事実集計を成立させる。血統・調教を外してもAIレースガイドの会員価値は成立する。

## 4. JRA-VAN調査

技術候補:

- `RACE`内RA/SE: 現在レース、出走馬、結果
- `RCOV/RCVN`: 出走馬に関連するmaster・過去走
- SE: 馬体重、増減、着順、走破時計、着差、各corner、単勝オッズ、人気、後3F等のfieldを仕様上保持
- `WH`: 速報馬体重
- `WE`: 速報天候・馬場
- 競走馬master: 3代血統
- `BLOD/BLDN`: 血統情報
- `SLOP`、`WOOD`: 調教
- `0B30`: 速報オッズ

現行コードへ追加取得は実装していない。公開仕様PDFとSDK 5.0.0の差、実契約のdataspec、提供期間をPhase 1C-2前に再確認する。

## 5. License判定

現在の判定:

| Use | 判定 |
| --- | --- |
| Storage | LEGAL_REVIEW_REQUIRED |
| Derived Fact | LEGAL_REVIEW_REQUIRED |
| 無料/有料会員Display | LEGAL_REVIEW_REQUIRED |
| External AI | PROHIBITED相当。書面承認まで送信しない |
| Model training | PROHIBITED |

技術的に取得可能でも利用可能とは扱わない。普通のData Lab利用キーで本番化しない。

## 6. 外部AIなしの成立性

外部AI送信が禁止されても、Deterministic Fact Builder＋固定Template RendererでV1を提供できる。許諾されたFactだけを外部AIへ渡す方式や閉域modelは将来候補とし、Phase 1C-1では選定しない。

## 7. コード変更判断

Domain/DB/API/UIの変更は行わなかった。source契約・field範囲・retentionが未確定の状態でcontractやmigrationを先行追加すると、誤った権利前提を固定するためである。

Phase 1C-2 migration案:

- 永続`SourceImportBatch`
- append-only `SourceRecordObservation`
- Race/Entry/Result/Performanceへsource observation link
- source window completenessとreason code
- current entry measurement snapshot（馬体重を採用する場合のみ）

名称と粒度は契約確定後に既存schemaと再照合する。

## 8. 禁止事項の確認

- 実データ取得なし
- JRA-VAN追加record実装なし
- backfillなし
- 外部AI/LLM通信なし
- AI予測、勝率、買い目、購入金額なし
- 本番deploy/migration/feature flag変更なし

## 9. 検証結果

今回の変更は文書のみで、Domain、DB、API、UIには変更がない。

- `git diff --check`: PASS
- `pnpm lint`: PASS
- `pnpm typecheck`: PASS
- `pnpm test`: PASS（Vitest 79 files / 440 tests、補助Node test 19 tests）
- integration/E2E: Phase 1B実装に変更がないためローカルでは再実行せず、PRの既存CIでregressionを確認する
- 外部HTTP通信: JRA-VAN・外部AIへの通信なし。調査は公開されている公式資料の閲覧だけ

## 10. 判定

### 技術面

`CONDITIONAL GO`。既存基盤は再利用可能だが、実データ用の永続provenance/completeness取込層が必要。

### データ面

`GO`。V1最小fieldと過去走範囲は決定できた。

### ライセンス面

現時点は`NO-GO`。Data Lab通常契約では商用会員提供ができず、JRADBまたは同等の書面許諾が未取得。

### AI面

`CONDITIONAL GO`。外部AIへ送れるfieldは0件として開始する。許諾後もFact allowlistだけを対象にする。

### 総合

`CONDITIONAL GO`。

契約・field/use別許諾・retention・訂正・外部処理条件が確定するまで、実データ取込を開始してはならない。

## 11. 次Phase提案

Phase 1C-2または1C-3へ直行せず、最初に「Commercial Data License Gate」を完了する。

1. JRADBおよび必要に応じて別providerへ法人問い合わせ
2. checklistをfield/use別に書面確定
3. 採用sourceとV1 fieldを承認
4. その後にPhase 1C-2として実データ取込層をsynthetic/licensed sampleで実装
5. stagingでcompleteness・correction・resumeを検証
6. External AIが許可された場合だけ、別承認後にPhase 1C-3を検討

Phase 1C-3を先に進めない。

## 作成文書

- `docs/AI_RACE_GUIDE_DATA_SOURCE_MATRIX.md`
- `docs/AI_RACE_GUIDE_V1_DATASET.md`
- `docs/AI_RACE_GUIDE_BACKFILL_PLAN.md`
- `docs/AI_RACE_GUIDE_LICENSE_CHECKLIST.md`
- `docs/AI_RACE_GUIDE_PHASE1C1_RESULTS.md`
