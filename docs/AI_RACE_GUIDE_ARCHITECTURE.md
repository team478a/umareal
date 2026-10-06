# AIレースガイド アーキテクチャ案

作成日: 2026-10-05

対象: Phase 1以降の設計案。Phase 0では実装しない。

## 1. 責務と非責務

AIレースガイドの責務は、許諾済みの競馬データを決定的なロジックで整理し、その構造化事実を会員が読みやすい日本語に変換することである。

### 行うこと

- レース条件、出走馬、過去成績、条件適性、血統等の事実整理
- 決定的なルールによる注目材料・注意材料・データ差・情報不足の抽出
- レース展開を考えるための参考材料の提示
- パドックで確認したい観察項目の提示
- 確定結果を使った事後の振り返り
- 上記の根拠を保った自然言語説明

### 行わないこと

- 三国谷氏の評価、発言、印の生成・修正・推測
- 勝ち馬、買い目、購入額、勝率、的中率、期待利益の生成
- パドック映像・画像の自動判定
- 馬券の購入、投票、代行
- 入力に存在しない事実、数値、因果関係の補完

「注目馬候補」は馬券推奨ではない。UIとAPIで `recommendedBets`、`winProbability`、`honmei` 等の予想用語を使用せず、`attentionHorses` と根拠factだけを返す。

## 2. 三国谷パドックとの境界

境界はDB、API、UIの全層で維持する。

| 層 | 三国谷パドック | AIレースガイド |
| --- | --- | --- |
| DB | `Assessment`、`AssessmentVersion`、`Prediction`、`PredictionVersion` | 専用 `AiRaceGuide*` model |
| 作成主体 | EXPERTまたは権限ある管理者 | 決定的fact builder、LLM、承認管理者 |
| 入力 | 現場観察と専門家判断 | 許諾済み構造化データのみ |
| API | 既存assessment/prediction endpoint | 専用guide endpoint |
| UI | 常に主表示 | 三国谷パドックの後に補助表示 |
| 表示名 | 三国谷パドック評価 | AIレースガイド |
| 訂正 | 既存versioning | AI guide独自versioning |

事前AI生成には `Assessment`、`Prediction`、三国谷氏の非公開コメントを入力しない。これによりAIが専門家評価を先取り、模倣、上書きする経路を構造上なくす。事後分析で両者を比較する場合も、元versionを参照する別の分析処理とし、本人の発言として文章化しない。

## 3. データフロー

```text
許諾済みデータ
  ↓ import / normalize
既存 Race・Horse・RaceEntry・RaceResultVersion
  ↓ deterministic fact builder
根拠ID付き構造化fact + 欠損状態 + data cutoff
  ↓ immutable input snapshot / input hash
LLM（説明文のみ、外部検索・tool利用なし）
  ↓ strict JSON
schema・根拠ID・数値・禁止表現の決定的検証
  ↓
管理者レビュー
  ↓ append-only publish
FREE_PREVIEW / PAID_FULL のサーバー側投影
```

結果後の振り返りは、公開済み事前ガイドを書き換えない。

```text
公開済み事前guide version + 確定RaceResultVersion
  ↓ 新しいcutoffとsnapshot
別の振り返りgeneration
  ↓ 検証・承認
新しいretrospective version
```

## 4. Domain contract案

### 4.1 欠損と根拠

全factは値だけでなく状態と根拠を持つ。

```ts
type FactState = "KNOWN" | "UNKNOWN" | "INSUFFICIENT_DATA" | "NOT_AVAILABLE";

type EvidenceRef = {
  evidenceId: string;
  sourceKind: string;
  sourceRecordId?: string;
  sourceVersion: string;
  observedAt?: string;
};

type Fact<T> = {
  state: FactState;
  value?: T;
  evidenceIds: string[];
};
```

`KNOWN` 以外では `value` を禁止する。ゼロ、空配列、空文字を不明値の代わりに使わない。LLM出力の各記述は1つ以上の `evidenceId` を参照する。

### 4.2 ガイド内容

V1候補contract:

- `raceOverview`
- `attentionMaterials[]`
- `attentionHorses[]`
- `positiveFactors[]`
- `cautionFactors[]`
- `courseSuitability[]`
- `distanceSuitability[]`
- `goingSuitability[]`
- `pedigreeReferences[]`
- `recentPerformance[]`
- `paceScenarioReferences[]`
- `raceComplexity`
- `paddockCheckPoints[]`
- `dataCutoffAt`
- `generatedAt`
- `modelVersion`
- `logicVersion`
- `promptVersion`
- `sourceVersion`

`raceComplexity` は的中容易度ではなく、データ差と情報充足度を表す。例は `CLEAR_DATA_DIFFERENCES`、`BALANCED_DATA`、`INSUFFICIENT_DATA` とし、「簡単」「鉄板」等を使わない。

## 5. 保存モデル案

既存 `Race` / `Horse` / `RaceEntry` / `RaceResultVersion` を複製しない。名称はPhase 1 migration作成時に最終確定する。

### `AiRaceGuide`

1レース1行の現在workflow。

- `id`, `raceId` unique
- `status`
- `revision`
- `latestGenerationId`
- `createdAt`, `updatedAt`, `updatedById`

候補status:

`DATA_PENDING` → `QUEUED` → `GENERATING` → `VALIDATING` → `REVIEW_REQUIRED` → `READY` → `PUBLISHED`

失敗時は `FAILED`、入力更新時は `STALE`。公開済みversionそのもののstatusは変更しない。

### `AiRaceGuideGeneration`

生成試行ごとのappend-only行。

- `guideId`, `attemptNo`
- `structuredInputSnapshot` JSON
- `sourceManifest` JSON
- `inputHash`
- `dataCutoffAt`, `sourceVersion`
- `logicVersion`, `promptVersion`, `modelProvider`, `modelVersion`
- `generatedOutput` JSON nullable
- `validationStatus`, `validationErrors` JSON
- `failureCode` nullable
- `requestedById`, `startedAt`, `generatedAt`, `completedAt`

prompt本文、API key、providerの生レスポンス中の機密metadataは保存しない。prompt本文はリポジトリのversioned templateとして管理し、DBにはversion/hashを保存する。

### `AiRaceGuideVersion`

承認・公開した内容のappend-only行。

- `guideId`, `version`, `generationId`
- `kind`: `PRE_RACE` / `RETROSPECTIVE`
- `previewSnapshot` JSON
- `fullSnapshot` JSON
- `dataCutoffAt`, `generatedAt`, `publishedAt`
- `modelVersion`, `logicVersion`, `promptVersion`, `sourceVersion`
- `publishedById`
- `previousVersionId`, `correctionReason` nullable
- `createdTxId`

`guideId + version` と `generationId` をuniqueにする。UPDATE、DELETE、TRUNCATEはDB triggerで拒否する。訂正は前版を参照する新versionとして公開する。

### `AiRaceGuideVersionHorse`

HORSE CARDと検索のための関係link。Race/Horse情報の複製ではない。

- `versionId`, `horseId`, `raceEntryId`
- `relationKind`: `ATTENTION` / `POSITIVE` / `CAUTION` / `PADDOCK_CHECK`
- 複合index

本文・数値は公開snapshotに固定し、linkは検索用とする。

## 6. LLMに事実を生成させない仕組み

1. fact builderは通常コードとversioned ruleだけで計算する。
2. 入力snapshotをcanonical JSON化し、hashを保存する。
3. LLMへはsnapshotと文体指示だけを送り、検索・browser・function toolを与えない。
4. 出力は自由文章ではなくstrict JSON schemaに限定する。
5. 各文・各factorに `evidenceIds` を必須化する。
6. 出力中の馬名、数値、日付、レース条件を入力のallowlistと照合する。
7. 「必勝」「的中保証」「買い」「○円」等の禁止表現を検出する。
8. 根拠不足、未知値の言い換え、schema不一致は公開不可にする。
9. V1は人の承認なしに公開しない。

validatorが文章の真偽を完全に判断できるとは仮定しない。事実表現を小さなtemplate単位に限定し、可能な箇所はLLMを使わずrendererで文章化する。LLMは説明の接続・要約に限定する。

## 7. 公開フロー

1. 管理者が対象レースとcutoffを確認して生成を依頼
2. workerが権利区分を満たすsourceだけでsnapshotを構築
3. snapshot作成後に元データrevisionが変われば `STALE`
4. LLM生成、決定的検証
5. 管理者が根拠、欠損、禁止表現、表示範囲を確認
6. 公開直前にinput hashとrace revisionを再確認
7. transaction内でversion、audit log、current pointerを作成
8. 会員APIは最新公開versionのみ返す

V1では自動公開とLINE通知を行わない。予約公開・通知は、手動フローの安定と権利確認後に既存scheduler/notification patternへ追加する。

## 8. FREE_PREVIEW / PAID_FULL

既存会員区分と課金処理は変更しない。

- 権限なし・無料会員: `previewSnapshot`
- 対象日の1日利用: その `raceDate` の `fullSnapshot`
- 創設月額・通常月額: entitlement有効期間内の `fullSnapshot`
- 管理者: レビュー権限により未公開を含む管理response

無料previewの具体的項目は事業決定が必要。初期案はレース概要、情報充足度、データ時刻までとし、馬ごとの詳細材料とパドック確認点を有料全文とする。これは課金仕様ではなくpublic projectionで実現する。

APIは全文を送って画面で隠す方式を禁止する。認可後のprojectionだけを返し、CDN/cache keyにもaccess scopeを含める。

## 9. バージョニング

| 値 | 意味 |
| --- | --- |
| `generatedAt` | providerから有効な出力を得た時刻 |
| `dataCutoffAt` | 入力に含めた事実の最終時点 |
| `publishedAt` | 人が公開を確定した時刻 |
| `modelVersion` | exact model IDと推論設定hash |
| `logicVersion` | fact builder・決定ルールのversion |
| `promptVersion` | prompt templateのversion/hash |
| `sourceVersion` | 入力schema、provider manifest、data specificationのversion |

現在時刻や結果を使って過去versionを再描画しない。公開responseはversion snapshotから作る。表示上の訂正は新versionを作り、旧版は監査・内部比較のため保持する。

## 10. エラー時の扱い

| 状況 | 状態・動作 | 会員表示 |
| --- | --- | --- |
| 必須データなし | `DATA_PENDING` または不足fact | 未公開、または明示的に「データ不足」 |
| 任意データなし | factを `UNKNOWN` 等にする | 推測しない |
| source license不明 | snapshot作成拒否 | 未公開 |
| 入力更新 | `STALE`、再生成要求 | 旧公開版には時刻を表示し、上書きしない |
| schema/根拠検証失敗 | `REVIEW_REQUIRED` または `FAILED` | 未公開 |
| 公開transaction失敗 | rollback | 直前の公開版を維持 |
| 結果訂正 | 新しい振り返りversion | 旧版を改変しない |

内部error、prompt、未公開output、source raw dataを会員APIへ返さない。request IDだけをaudit/logと結びつける。

## 11. LLM障害時の扱い

- generationは非同期jobとし、会員request内でLLMを呼ばない。
- timeout、rate limit、5xxは分類し、指数backoffと上限回数を設定する。
- invalid JSONや根拠不一致を通信retryで無限再実行しない。
- circuit breaker発動中は新規jobを停止する。
- 公開済みversionはそのまま提供し、「最新」と誤認させないようcutoffを表示する。
- 公開版がない場合は通常のレース画面を維持し、三国谷パドックを阻害しない。
- provider障害時に、未検証templateや別modelへ自動fallbackして公開しない。

feature flag初期値:

- `AI_RACE_GUIDE_ENABLED=false`
- `AI_RACE_GUIDE_GENERATION_ENABLED=false`
- `AI_RACE_GUIDE_PUBLICATION_ENABLED=false`
- `AI_RACE_GUIDE_TRANSPORT=disabled`

`TRANSPORT=template`はJRA-VAN未接続のBasic Guide用であり、登録済みのRace/RaceEntry Factを固定テンプレートへ変換する。外部通信・予測・自動公開は行わない。`test`は非本番のsynthetic検証専用、`disabled`は生成拒否とする。

生成、公開、表示を別々に停止できるようにする。

## 12. セキュリティ・運用

- provider credentialはworkerだけに置き、Web/API responseやDB snapshotに保存しない。
- 外部AIへ送るfieldはallowlist化し、ライセンス区分を通過しないsourceを拒否する。
- 三国谷氏の非公開コメント、音声、画像はV1で送信しない。
- providerの学習利用、保持期間、region、subprocessor、削除手段を契約で確認する。
- ADMIN/EXPERTの既存AAL2と監査ログを維持し、生成依頼・承認・公開を記録する。
- 同一人物による生成依頼と公開を許すか、二者承認にするかは運用決定事項とする。

## 13. 設計上の受入条件

- AIを無効にしても既存レース、パドック、予想、結果が完全に動作する。
- 入力にない馬名・数値・条件を含むoutputを公開できない。
- 公開済みガイドを結果確認後に更新・削除できない。
- AIガイドからPrediction/Assessmentを更新するコードパスがない。
- 無料responseに有料全文が含まれない。
- 全公開versionから入力hash、cutoff、logic/prompt/model/source versionへ到達できる。
- 三国谷パドックが存在する画面では、それがAIガイドより先に表示される。
