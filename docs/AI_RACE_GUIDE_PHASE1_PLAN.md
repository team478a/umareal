# AIレースガイド Phase 1 実装計画案

作成日: 2026-10-05

状態: Phase 1Aローカル実装完了。Phase 1B以降は未承認・未着手。

## Phase 1Aの確定範囲

2026-10-05の着手承認により、Phase 1Aは次に限定する。

- `AGENTS.md`、`docs/SPEC.md`、`docs/DECISIONS.md`への承認方針の反映
- 根拠、欠損状態、source利用許諾、生成output、公開projectionのDomain contract
- canonical input仕様と、synthetic fixtureによるunit test
- `DETERMINISTIC_TEST` / `EXTERNAL_LLM`の処理区分。外部AI処理は明示的な利用許諾がないsourceをcontractで拒否する

Phase 1AではDB schema、migration、API、worker、管理画面、会員画面を変更せず、JRA-VAN実通信、外部AI API、live credential、本番デプロイを行わない。これらはPhase 1B以降の個別承認対象とする。

## 1. V1の最小スコープ

V1は「1レースの許諾済み構造化データからAIレースガイドを生成し、管理者が根拠を確認して手動公開し、会員権限に応じてpreview/fullを表示する」までとする。

含める:

- レース概要
- 現在DBで根拠を確保できる注目材料・注意材料
- 条件を満たした場合のみ注目馬候補
- 情報充足度を含むレース難易度
- パドックで確認したいポイント
- cutoff、生成・公開時刻、各version
- 人による承認、append-only公開、FREE_PREVIEW/PAID_FULL

含めない:

- 自動公開、LINE通知、公開予約
- 買い目、購入額、勝率、期待値
- 画像・動画解析
- 三国谷評価をAI入力に含めること
- HORSE CARD本体
- 自動振り返り、prediction model、学習pipeline
- 調教、血統、網羅的過去走等、権利・取得・品質が未確定の項目

## 2. 着手Gate

実装開始前に全て承認する。

1. `AGENTS.md`、`SPEC.md`、`docs/DECISIONS.md`の変更案
2. AIは補助であり、三国谷パドックが主役であるUI原則
3. V1 field allowlistとminimum data requirements
4. sourceごとの表示・派生・保存・外部AI送信許諾
5. 外部AI providerの学習利用、retention、region、security条件
6. previewに含める項目と有料全文の項目
7. 公開責任者、訂正手順、障害時連絡先

権利確認が完了しない場合、外部AI連携を実装せず、synthetic fixtureと決定的template providerまでに限定する。

## 3. 実装順

### Step 0: 方針承認

- 方針文書を承認内容に限定して更新
- 禁止事項、責任境界、用語を確定
- architecture decisionを記録

### Step 1: Domain contract

- `FactState`、`EvidenceRef`、input/output schema
- 注目馬候補と予想印の型を完全分離
- unknown、禁止表現、時刻、version contract
- canonical JSONとinput hash仕様
- preview/full projection contract

この段階はsynthetic fixtureだけでtestする。

### Step 2: Additive DB migration

- `AiRaceGuide`
- `AiRaceGuideGeneration`
- `AiRaceGuideVersion`
- `AiRaceGuideVersionHorse`
- index、unique、FK、append-only trigger
- SystemSetting access policy schemaの後方互換拡張

既存tableの意味・既存dataを変更しない。migrationはstaging copyでforward-only検証する。

### Step 3: Deterministic fact builder

- Race/Entry/confirmed Result等の許諾済みfieldだけを読む
- field allowlistとlicense policyをコードで強制
- evidence ID、coverage、cutoff、source versionを構築
- 不足値を状態へ変換
- generation後のrevision差分でstale判定

### Step 4: Provider abstractionとvalidator

```ts
interface AiRaceGuideNarrativeProvider {
  generate(input: AiRaceGuideStructuredInput): Promise<AiRaceGuideGeneratedOutput>;
}
```

- `disabled`: 常に外部送信を拒否
- `test`: fixtureから決定的outputを返す
- 承認後のみ外部provider adapterを追加
- strict JSON schema、evidence、数値、馬名、禁止表現validator
- timeout、retry上限、circuit breaker

providerの自由なtool利用・Web検索は禁止する。

### Step 5: 非同期generation job

- 管理APIはjobを作成して即時応答
- workerだけがprovider credentialを持つ
- claim、lease、retry、idempotency、dead-letter状態を実装
- 同一input hashの重複生成を抑止
- audit logにrequester、状態、request IDを記録

### Step 6: 管理API・管理画面

- レース選択、data coverage、cutoff確認
- 生成依頼、進捗、失敗分類
- 入力factと出力文のevidence照合
- preview/full確認、承認、公開、訂正版公開
- stale・権利未確認・validation failure時はpublish buttonを無効化

V1では生成文章の自由編集を避ける。修正はrule/sourceの修正後に再生成し、事実にない人手追記を防ぐ。

### Step 7: 会員API・会員画面

- 最新公開versionだけを取得
- entitlementをサーバーで評価してpreview/fullを投影
- 三国谷パドックの後にAIレースガイドを表示
- AI表示、cutoff、generated/published時刻、情報不足を明示
- ガイドなし・障害時も既存ページを通常表示

### Step 8: Staging検証と段階公開

- synthetic/許諾済みfixtureでintegration/E2E
- production相当の権限、cache、timezone、mobile表示を確認
- 内部管理者だけ → 無料preview → 有料fullの順でflagを開く
- 最初の実レースは二者確認を推奨

## 4. DB migration案

Migrationはadditiveにし、既存data backfillを必須にしない。

### 制約

- `AiRaceGuide.raceId` unique
- `AiRaceGuideGeneration(guideId, attemptNo)` unique
- `AiRaceGuideGeneration.inputHash` index
- `AiRaceGuideVersion(guideId, version)` unique
- `AiRaceGuideVersion.generationId` unique
- `AiRaceGuideVersionHorse(versionId, horseId, relationKind)` unique候補
- generation/versionからRace、Horse、EntryへのFK整合
- 公開versionのUPDATE/DELETE/TRUNCATE禁止
- current pointer更新とversion作成を同一transactionにする

JSONだけに閉じず、時刻、各version、status、hash、公開者、FKは列にする。大量のraw JRA-VAN recordをAI tableへ複製しない。

## 5. API案

パスは既存routing規約に合わせてPhase 1時に確定する。

### 管理

| Method / path候補 | 用途 |
| --- | --- |
| `GET /admin/races/:raceId/ai-guide` | workflow、coverage、generation一覧 |
| `POST /admin/races/:raceId/ai-guide/generations` | generation job作成 |
| `GET /admin/ai-guide/generations/:id` | 状態・検証結果取得 |
| `POST /admin/ai-guide/generations/:id/approve` | 承認 |
| `POST /admin/ai-guide/generations/:id/publish` | 新version公開 |
| `POST /admin/races/:raceId/ai-guide/corrections` | 訂正版generation開始 |

全writeはCSRF、AAL2、RBAC、revision/idempotencyを既存規約に合わせる。公開は監査transaction必須。

### 会員

| Method / path候補 | 用途 |
| --- | --- |
| `GET /races/:raceId/ai-guide` | entitlement投影済み最新公開版 |
| 既存race list responseのmetadata | `available`、`scope`、`publishedAt`だけ |

会員responseにstructured input、prompt、validation error、未公開generation、内部scoreを含めない。

## 6. 管理画面案

1. 対象レース・発走時刻・現在revision
2. data coverageとlicense gate
3. cutoff、source version、input hash
4. 各factとevidence
5. 生成文との対応
6. validator結果と禁止表現
7. 無料preview / 有料fullの実表示
8. stale警告、承認、公開、訂正理由

生成結果を「三国谷氏の予想」と呼ばない。公開済みversionを編集する操作を提供しない。

## 7. 会員画面案

表示順:

1. レース基本情報
2. 三国谷パドック評価・最終評価（存在する場合）
3. AIレースガイド
4. レース結果
5. 振り返り（将来）

パドック対象外は、AIレースガイド → 結果 → 将来の振り返り。AIカードには「参考情報」「買い目ではない」「データ時点」を明示する。有料lock時もfull payloadは送らない。

## 8. Test計画

### Unit

- fact stateと欠損変換
- canonical JSON / input hash
- 最低母数、除外、同点、丸め
- evidence IDの存在・参照整合
- 数値・馬名allowlist
- 禁止語・買い目表現の拒否
- preview/full projection
- entitlementの期間・対象日境界
- stale判定

### DB / integration

- migrationのforward適用
- version連番・unique・FK
- 公開versionのUPDATE/DELETE/TRUNCATE拒否
- 同時生成・同時公開の競合
- generation失敗時に公開版が変わらない
- day pass、創設月額、通常月額、無料会員のresponse差
- admin/expert/member権限とAAL2
- result訂正時にPRE_RACE versionが不変

### Provider contract

- timeout、429、5xx、invalid JSON
- schemaは正しいがevidence不正
- 入力にない数値・馬名
- retry上限、circuit breaker、credential非露出

### E2E

- 管理者: 生成 → レビュー → 公開
- staleになったgenerationを公開できない
- 無料previewと有料full
- 1日利用が別日を閲覧できない
- mobileで三国谷パドックがAIより先
- ガイドなし/worker停止時もrace pageが正常
- 訂正版公開後も旧版が監査可能

## 9. Integration test fixture

実データ・実credentialを使わないfixtureを用意する。

- 完全データのレース
- 一部過去走不足
- 全過去走不足
- 同名馬候補、取消、乗替り
- 発走時刻・馬場の更新
- assessment/predictionがあるレース（AI入力に混入しないことを確認）
- providerが未知の数値を返すケース
- result訂正ケース

golden textの完全一致より、schema、evidence、禁止表現、projection、不変条件を中心にtestする。

## 10. Rollback

1. `AI_RACE_GUIDE_PUBLICATION_ENABLED=false`
2. `AI_RACE_GUIDE_GENERATION_ENABLED=false`
3. `AI_RACE_GUIDE_ENABLED=false`
4. worker jobを安全に停止し、未完了jobをfailed/pausedへ分類
5. 既存race/paddock/prediction/resultはそのまま運用
6. additive tableと公開履歴は削除しない
7. 必要ならアプリコードだけ前versionへ戻す

down migrationで監査履歴を消さない。誤った公開内容は削除・上書きせず、表示flagを閉じたうえで訂正版versionを作る。

## 11. Feature flag

| Flag | 初期値 | 効果 |
| --- | --- | --- |
| `AI_RACE_GUIDE_ENABLED` | `false` | 会員・管理UIとread APIの露出 |
| `AI_RACE_GUIDE_GENERATION_ENABLED` | `false` | 新規job受付・worker実行 |
| `AI_RACE_GUIDE_PUBLICATION_ENABLED` | `false` | publish write |
| `AI_RACE_GUIDE_TRANSPORT` | `disabled` | `disabled` / `test` / 承認済みprovider |

productionではflag未設定をtrueと解釈しない。provider transportとpublicationは独立させ、外部送信だけ、または公開だけを即時停止できるようにする。

## 12. Definition of Done

- 方針・データ権利・provider契約のGateが証跡付きで完了
- 全contractと不変条件にunit testがある
- migrationが既存dataを変更せず、append-only制約がDBで効く
- AI入力にAssessment/Prediction/非許諾fieldが混入しない
- 全出力主張がevidenceへ到達し、不正outputを公開できない
- entitlement別responseに全文漏えいがない
- 三国谷パドックの優先順位がmobile E2Eで固定される
- AI/worker障害が既存サービスに影響しない
- rollback drillをstagingで完了
- 運用手順、障害対応、訂正手順を文書化

## 13. Phase 1判定

設計・synthetic fixture・無通信のdomain実装は、方針承認後に進められる。実データを使った外部AI生成と有料会員への公開は、データ利用許諾とprovider契約が確認できるまで開始しない。

判定: **CONDITIONAL GO**
