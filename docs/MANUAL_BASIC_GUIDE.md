# JRA-VAN未接続 Basic Guide

作成日: 2026-10-06

## 目的

JRA-VANや外部LLMへ接続しない初期運用でも、管理者が登録済みの事実だけを会員向けに整理できるようにする。三国谷パドックを主役とし、Basic Guideはその後に表示する補助情報である。

## 生成方式

- `AI_RACE_GUIDE_TRANSPORT=template`で固定テンプレートを使用する。
- HTTP、外部AI、JRA-VANへの通信は行わない。
- `Race`と`RaceEntry`の現在snapshotをEvidence付きFactへ変換し、決定的に同じ文章を生成する。
- `Assessment`、`Prediction`、`PredictionVersion`、三国谷氏コメント、会員情報は入力しない。
- 管理者による生成、検証、確認、公開の既存workflowを維持する。自動公開しない。
- 公開済み版は既存のPostgreSQL append-only制約で保護し、訂正は新しいgeneration/versionとする。

## 表示内容

- レース概要: 競馬場、レース番号、レース名、芝/ダート、距離、登録頭数。
- 登録済み出走馬: 馬番と馬名。
- 詳細不足: 性齢、斤量、騎手、調教師等が不足する場合は「未登録」と表示する。
- パドック確認: 歩様、落ち着き、発汗等を人が確認する一般的な案内。自動状態判定はしない。

データ不足を「苦手」「成績不振」「実績なし」と解釈しない。勝率、的中率、印、買い目、購入金額、三国谷氏の発言に見せる文章は生成しない。

## Feature Flag

既定値はすべて停止のままとする。

```env
AI_RACE_GUIDE_ENABLED=false
AI_RACE_GUIDE_GENERATION_ENABLED=false
AI_RACE_GUIDE_PUBLICATION_ENABLED=false
AI_RACE_GUIDE_TRANSPORT=disabled
```

検証済み環境でBasic Guideを利用する場合だけ、三つのflagを個別に有効化し、transportを`template`へ変更する。`test`は従来どおり非本番のsynthetic provider専用である。

## DB変更

`202610060004_manual_basic_guide`は、既存`ai_race_guide_generations.modelProvider`のCHECKとINSERT guardへ`template`を追加する。既存行の更新・削除・backfillは行わず、generation/versionの追記専用triggerは変更しない。本番適用は通常のrelease gateと別承認を必要とする。

## ライセンス境界

Basic GuideはUMAREAL管理画面へ登録され、既に会員表示対象となる基本項目だけを使用する。外部AI送信許諾は不要だが、第三者データを手入力しただけで自社データに変わるわけではない。登録元の商用表示・保存許諾は運用側で確認し、未確認の外部データを登録・公開しない。

## 今回含めないもの

- 三国谷氏コメントのAI編集
- ORIGINAL / AI_DRAFT / APPROVEDの編集workflow
- 過去走、血統、調教、オッズの追加取得
- 外部LLM接続
- 勝敗予測、勝率、印、買い目
- 自動公開、LINE AI通知
- 本番feature flag変更、本番deploy、本番migration

## 検証結果

- local migration: PASS（87 migrations、`202610060004_manual_basic_guide`適用）
- typecheck: 5 workspaces PASS
- lint: PASS
- unit/script: 82 files・465 tests + Node 20 tests PASS
- Race/Prediction/Result/AI Guide integration: 21 tests PASS
- Basic Guide E2E: desktop/mobile 2 tests PASS
- build: 5 workspaces PASS

外部AI、JRA-VAN、Web scrapingへの通信は実装・実行していない。本番deploy、本番migration、feature flag変更も行っていない。
