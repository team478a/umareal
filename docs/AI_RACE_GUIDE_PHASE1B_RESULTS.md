# AIレースガイド Phase 1B 完了記録

作成日: 2026-10-05

基準main: `aaa451c38e4bc491933234f1d666e63c663eba5b`

## 実装概要

- 競馬データのA/B/C分類
- hashだけを保持するHorse external identityと手入力馬の重複候補判定
- `RaceResultVersion`を正本とするcutoff固定の過去走選択
- 現在保存先のない任意成績値だけを持つ `RaceEntryPerformance`
- source/field/用途別の `DataLicensePolicy`
- Evidence付きDeterministic Fact Builder
- Factごとのsample size、cutoff、logic version
- 結果訂正・未来データを含むSynthetic Fixture A〜H
- Phase 1A `AiRaceGuideStructuredInput`へのallowlist projection
- 管理者向けデータcoverage API/UI

## DB変更

additive migration `202610050006_ai_race_guide_phase1b_data_foundation`を追加した。

- `horse_external_identities`
- `data_license_policies`
- `race_entry_performances`

policyとperformanceは追記専用。external identityのprovider/hashは更新不可。既存Race/Horse/Entry/Result/Prediction/Assessmentの意味と既存データは変更しない。

## 安全境界

- Assessment、Prediction、三国谷コメント、User情報をFact入力schemaで拒否
- external AI送信はpolicy allowlistが全てAPPROVEDでなければ拒否
- Phase 1Bで外部provider・HTTP通信を追加しない
- JRA-VAN bridge、RA/SE取得範囲、ライブ通信を変更しない
- 本番backfill、migration、deployを行わない

## Future Leakage

対象レース前、cutoff以前に確定・観測・取込された結果だけを使用する。同一race/horseの訂正版はcutoff以前の最大version1件へ固定する。結果後にDBが更新されても過去cutoffへ混入しないことをunit/integrationで検証する。

## Data Coverage

管理者画面でRace、Entry、Past races、Pedigree、Trainingの状態・件数を確認できる。構造があってもpolicy未登録なら `LICENSE_REVIEW_REQUIRED` と表示する。

## 検証結果

- Prisma migration: 空のローカルPostgreSQLへ全83 migration適用成功
- Unit/regression: 79 files、440 tests PASS。補助Node検証19件PASS
- Phase 1B Domain: 20 tests PASS（既存11 + 新規9）
- JRA-VAN bridge: 22 tests PASS。Windows改行差を固定する `.gitattributes` を追加
- Phase 1B integration: 3 tests PASS
- Full integration初回: 38 files・143 tests PASS、Stripeローカル専用13 tests SKIP、既存6 filesは長時間Docker負荷によりtimeout/一時500
- 上記6 filesの分離再実行: 6 files・17 tests PASS（回帰なし）
- E2E: AIレースガイドのdesktop/mobile各1件、計2 tests PASS
- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- `pnpm build`: PASS
- 外部AI/JRA-VAN追加通信: 実装・実行なし

全integrationの単一連続実行だけはローカルDocker負荷で完全PASSにならなかったが、Phase 1B対象はすべてPASSし、失敗した既存領域も同一コード・同一DBで分離再実行して全件PASSした。

## 未実装

- 実JRA-VAN追加取得、過去走backfill
- 本番血統・調教・追切・時系列オッズ
- 外部AI接続・実データ送信
- AI予測、勝率、買い目、購入金額
- Horse Card、AI自動振り返り、LINE通知、自動公開
- `calm`から`sweating/calmness`へのmigration/UI変更
- 本番deploy・本番migration

## Phase 1C判定

`CONDITIONAL GO`候補。Phase 1Bの技術基盤は進行可能だが、実データ利用前にJRA-VAN等の保存・加工・商用表示・有料提供・外部AI送信の権利確認と別途承認が必要である。Phase 1Cへ自動的に進まない。
