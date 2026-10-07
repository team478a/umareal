# AIレースガイド Phase 0 現状監査

作成日: 2026-10-05

基準コミット: `main` / `bffc5dc`

状態: 設計のみ。実装、DB変更、API変更、UI変更、外部通信、デプロイは行っていない。

## 1. 結論

既存のレース、出走馬、三国谷パドック評価、公開予想、結果、会員権限、監査ログを再利用して、AIレースガイドを追加できる。ただし、本番提供は次の2条件を満たすまで **CONDITIONAL GO** とする。

1. JRA-VAN等に由来するデータの有料会員向け表示、加工、保存、外部AI事業者への送信について、書面または契約条項で利用可能範囲を確定する。
2. 「prediction AIを実装しない」という現行方針と、事実に基づく補助説明だけを許可する新方針との差分を承認し、`AGENTS.md`、`SPEC.md`、`docs/DECISIONS.md`を次フェーズで更新する。

AIレースガイドは `Prediction` の種類追加ではなく、別の補助情報として保存・公開する。画面順は常に「三国谷パドック → AIレースガイド」とし、AIから `Prediction`、`Assessment`、買い目、購入金額を生成しない。

## 2. 調査範囲

- Prisma schema、migration、domain contract
- API controller/service、worker、Web画面
- レース取込、結果取込、JRA-VAN bridge
- 公開予約、通知、監査ログ、会員権限
- `AGENTS.md`、`SPEC.md`、`docs/DECISIONS.md`
- JRA-VAN公式規約・Data Lab関連公開情報

ライブ認証情報、JRA-VAN実通信、外部AI APIは使用していない。

## 3. 現状実装と再利用判断

| 既存資産 | 現状 | AIレースガイドでの扱い |
| --- | --- | --- |
| `Race` | 開催日、場、番号、名称、発走時刻、クラス、距離、芝ダート、回り、馬場、天候を保持 | そのまま参照。AI用Raceを作らない |
| `Horse` | `id` と名称。JRA-VAN取込では血統登録番号から決定的UUIDを生成 | そのまま参照。血統・同定根拠は不足 |
| `RaceEntry` | 馬番、枠、性齢、斤量、騎手、調教師、単勝オッズ、人気、状態 | そのまま参照。時系列オッズや馬体重は不足 |
| `Assessment` | 現在のパドック評価を構造化JSONで保持 | AI入力から原則除外し、専門家領域として分離 |
| `AssessmentVersion` | 評価変更履歴、entry snapshot、操作者、理由 | 将来の事後分析で参照可能。公開前AI生成には使わない |
| `Prediction` | 三国谷氏の公開前ドラフト | AIガイド保存には流用しない |
| `PredictionVersion` | 公開版、公開範囲、信頼度、印、評価snapshot等を版管理 | append-only、訂正版、公開snapshotの設計を模範として再利用 |
| `RacePaper` / `RacePaperVersion` | レース紙の作業状態と公開版 | 公開・監査パターンのみ再利用。意味が異なるため保存先にはしない |
| `RaceResultDraft` / `RaceResultVersion` | 結果取込、確認、公開履歴 | 確定済みversionだけを振り返りの根拠にする |
| `PredictionEvaluation` | 公開予想と確定結果の評価 | AIを予想家扱いしないため流用しない |
| `ExpertAssignment` | レースごとの専門家割当 | 管理画面の操作可否に再利用可能。AI生成者の意味には使わない |
| `Entitlement` | plan code、期間、対象日、取消を保持 | 有料全文判定に再利用可能 |
| `SystemSetting.contentAccessPolicy` | `paddock`、`win5`、`racePaper`、`content` のplan許可 | `aiRaceGuide` policy追加候補。課金システムは追加不要 |
| `PublicationSchedule` | レース告知と無料レポートの予約公開 | claim/lock/audit方式は再利用可能。ただし現状kindはAI非対応 |
| `NotificationEvent` | 各公開物に対する通知イベント | nullable FKと整合制約の追加が必要。V1ではAI通知を対象外にすると安全 |
| audit log / transaction | 管理操作・公開操作の追跡 | 生成依頼、承認、公開、訂正に再利用 |
| `RaceDataProvider` | `races` / `entries` CSV parser境界 | 名前に反して取得元providerではなくparser。取得・来歴contractの追加が必要 |
| `ResultDataProvider` | canonical CSVとJRA-VAN bridge resultのregistry | provider registryの形式を参考にできる |

## 4. 三国谷パドック評価の構造化状況

`Assessment` のJSON contractは次の通り。

| 業務項目 | 現在の項目 | 状況 |
| --- | --- | --- |
| 馬体 | `body` | 0〜5で構造化済み |
| 歩様 | `walk` | 0〜5で構造化済み |
| 毛艶 | `coat` | 0〜5で構造化済み |
| 気合 | `focus` | 0〜5で構造化済み |
| 発汗 | `sweating` | 新規評価は0〜5で個別保存。旧版の`calm`は推測分割しない |
| 落ち着き | `calmness` | 新規評価は0〜5で個別保存。旧版の`calm`は推測分割しない |
| 総合変化 | `change` | `BIG_UP`〜`BIG_DOWN`、`UNKNOWN` |
| コメント | `paddockComment` | 構造化済み |
| 事前情報 | `preScore`、`preRank`、`preMark`、`preComment` | 構造化済み |
| 最終評価 | `PredictionMark` | Assessment外。公開予想versionに保存 |
| 結果 | `RaceResultVersion` | Assessment外。確定結果versionに保存 |

0点は「評価不能」を表す。将来の分析では0を最低評価として集計してはいけない。発汗と落ち着きは新規版で別軸として保存できるが、旧`calm`値を2軸へ推測変換してはならない。AI事前情報、パドック評価、最終予想、結果は `raceId`、`entryId`、`horseId` と各versionで結合できるが、同一時点を保証する分析用snapshotは未整備である。

## 5. JRA-VAN bridge監査

### 5.1 現在取得・保存しているもの

bridgeはJV-Linkから `RA` と `SE` を読み、bundle化して既存CSV importに渡す。現在のmappingは以下。

- `RA`: 開催日、場、レース番号、名称、条件名、距離、芝ダート、回り、発走時刻、馬場、天候
- `SE` 出馬: 血統登録番号由来UUID、馬番、枠、馬名、性齢、斤量、騎手、調教師、単勝オッズ、人気、出走状態
- `SE` 確定: 異常区分、着順、最終人気、最終オッズ、レース取消
- manifest: 件数、SHA-256、format version

対象は中央10場の芝・ダート平地。障害、海外、未知コード等は拒否する。血統登録番号は `uuid5(NAMESPACE_URL, "https://jra-van.jp/horse/{KettoNum}")` の材料として使うが、原値とsource identityはDBに保存しない。

### 5.2 取得可能性はあるが未実装

次はJRA-VANデータ仕様上の調査候補であり、現行コードは取得・正規化・保存していない。

- 馬マスタ、父・母・母父等の血統
- 網羅的な過去走、通過順、着差、走破時計、上がり等
- 調教・追切情報
- 馬体重と増減
- 時系列オッズ
- コースや条件別の集計材料
- 各項目の更新番号・訂正履歴とAI入力まで追跡できるsource reference

「データ仕様に存在する可能性」と「本サービスで契約上利用できる」は別である。レコード種別、提供期間、取得上限、保存期間も実契約と最新仕様書で再確認する。

### 5.3 権利・ライセンス判定

JRA-VAN公式の[利用規約](https://jra-van.jp/info/rule.html)は、私的利用を超える複製、改変、公衆送信、配布等を制限し、承諾された例外を除く旨を定めている。Data Labの[SDK案内](https://jra-van.jp/dlb/sdv/sdk.html)や[サービス案内](https://jra-van.jp/dlb/sdv/about.html)が存在しても、UMAREALの有料会員表示、派生情報、保存、外部LLM送信が当然に許可されるとは判断できない。

したがって、JRA-VAN由来の全項目について次を **LEGAL/DATA LICENSE REVIEW REQUIRED** とする。

- 商用会員サービス内で原データ・要約・派生評価を表示できるか
- キャッシュ、永続保存、履歴保持、訂正版保持ができるか
- 統計量・条件適性・難易度などの派生物を作成・提供できるか
- 外部AI事業者を第三者処理者として利用できるか
- モデル学習、ログ保持、海外移転を禁止または制限すべきか
- 出典表示、削除、訂正、監査に関する義務

権利確認前に「実装可能」と扱わない。許諾が得られない場合は、利用許諾済みデータ、自社入力データ、または決定的処理だけで構成する代替案へ切り替える。

## 6. HORSE CARD将来対応

JRA-VANから取り込まれた馬は血統登録番号由来の決定的UUIDでレース横断参照できるため、技術的な核はある。一方、手入力・CSV取込で別IDが渡された場合の名寄せ、source system、原識別子、統合・分割履歴がない。

よって将来対応は **条件付きで可能**。Phase 1で公開AI versionと `Horse` を結ぶ軽量linkを持たせ、別途次を設計する。

- horse identity provider / external key / provenance
- 重複候補の人手確認とmerge履歴
- 血統・過去走をRace/Horse/Entryの複製ではなく関係データとして追加
- 過去のAIガイドは公開versionを参照し、結果後に上書きしない

## 7. 現在不足するもの

1. AIガイド専用のworkflow、生成試行、公開version、根拠snapshot
2. 項目単位のsource reference、data cutoff、入力hash
3. `UNKNOWN` / `INSUFFICIENT_DATA` / `NOT_AVAILABLE` を含む共通fact contract
4. LLM出力の全主張を入力factへ結びつけるvalidator
5. AIガイド用のaccess policyとpublic projection
6. 管理者の生成依頼、検証、承認、公開、訂正UI
7. 会員画面上の従属表示と、AIであること・生成時刻・データ時点の表示
8. LLM障害、stale data、検証失敗に対する状態遷移とkill switch
9. AI入力・出力の個人情報、機密情報、ライセンス区分
10. 発汗と落ち着きの分離、時点を固定した横断分析snapshot

## 8. 技術的リスク

| リスク | 影響 | 対応 |
| --- | --- | --- |
| LLMが入力にない事実・数値を補う | 誤情報、信用毀損 | 証拠ID付き構造化入力、JSON出力、数値照合、未確認時は非公開 |
| 現行DBが全開催を網羅しない | 過去成績・適性が偏る | completenessを明示し、不足は `INSUFFICIENT_DATA` |
| データ更新後も古い説明を表示 | 誤案内 | input hashとcutoff、stale判定、再生成後に別version公開 |
| AIが三国谷予想に見える | 商品価値・責任境界の混同 | 別model/API/UI、名称、色、文言、表示順を固定 |
| JSON中心で検索性が不足 | HORSE CARDや分析が困難 | version-horse linkと主要metadataは列で保持 |
| scheduler/notificationへ一気に追加 | 誤公開・誤通知 | V1は手動承認・手動公開、通知なしを推奨 |
| 外部AI停止・rate limit | 公開遅延 | 非同期job、retry上限、circuit breaker、既存公開版を維持 |

## 9. 変更候補ファイル

Phase 0では変更しない。Phase 1の候補は以下。

- `packages/db/prisma/schema.prisma` と新規additive migration
- `packages/domain/src/ai-race-guide.ts`、export、unit test
- `apps/api/src/main.ts`
- `apps/api/src/ai-race-guide.controller.ts`
- `apps/api/src/ai-race-guide.service.ts`
- `apps/worker/src/ai-race-guide-runner.ts`
- `apps/worker/src/ai-race-guide-provider.ts`
- `apps/web/app/(media)/races/[raceId]/page.tsx`
- `apps/web/components/ai-race-guide.tsx`
- `apps/web/app/admin/ai-race-guides/...`
- access policy、audit、integration/E2E testの既存関連ファイル

既存ファイル名・配置はPhase 1着手時の最新mainに合わせて再確認する。

## 10. DB・API・UI変更候補

### DB

- current workflowを表す `AiRaceGuide`
- append-only生成試行と入力snapshotを表す `AiRaceGuideGeneration`
- append-only公開版を表す `AiRaceGuideVersion`
- Horse/RaceEntryとの検索可能なlinkを表す `AiRaceGuideVersionHorse`
- 公開versionのUPDATE/DELETE/TRUNCATE拒否trigger
- `contentAccessPolicy.aiRaceGuide` の設定追加

### API

- 管理: 生成依頼、状態取得、検証結果、承認、公開、訂正版公開
- 会員: 対象日の一覧metadataとレース別最新公開版
- public responseはサーバー側で `FREE_PREVIEW` / `PAID_FULL` を投影
- 非公開の入力snapshot、prompt、provider error、内部scoreは返さない

### UI

- レース詳細で三国谷パドックを先、AIレースガイドを後に表示
- AIラベル、data cutoff、generated/published時刻、versionを表示
- 欠損は推測せず「データ不足」「取得対象外」等で表示
- 管理画面では根拠、検証エラー、stale、公開範囲を確認

## 11. 方針文書の変更提案（未適用）

### `AGENTS.md`

現行の「prediction AIを実装しない」を次の趣旨へ限定する提案。

> 自動予想、買い目生成、購入金額決定、画像・動画からのパドック自動判定、専門家評価の上書きは禁止する。承認済みの構造化事実だけを入力とし、根拠参照・履歴・検証・明示的なAI表示を備えた補助説明は、三国谷パドックと別model/API/UIでのみ許可する。

### `SPEC.md`

- 主役が三国谷パドックであること、AIは従属するレースガイドであることを追加
- 対象機能に構造化事実の整理・説明を追加
- 非対象に自動予想、買い目、確率生成、専門家評価上書きを明記
- provenance、cutoff、version、欠損値、公開審査を非機能要件に追加

### `docs/DECISIONS.md`

- Phase 0の `CONDITIONAL GO` と権利確認gateを記録
- PredictionとAI guideのmodel分離、append-only公開版、LLM非事実生成を決定事項として追加
- Phase 1承認日、許諾根拠、採用provider、保持ポリシーは未決定として残す

これらは提案のみであり、本Phaseでは一切変更していない。
