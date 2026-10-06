# JRA-VAN未接続 初期運用監査

作成日: 2026-10-06
基準main: `e2740470e90004ff533ebd1cf4c7163ba80f0837`

## 結論

UMAREALの主要DomainはJRA-VANから分離されており、レース、出走馬、Assessment、Prediction、公開版、結果版、成績は内部標準モデルで動作する。JRA-VAN bridgeはWindows上でRA/SEを標準CSVへ変換する任意の入力経路であり、Web/API起動時のSDK、JV-Link、認証情報、ネットワーク接続は不要である。

したがってJRA-VANコードの削除や主要Domainの再設計は不要である。一方、初期手動運用には出走馬の全詳細入力が必須で、未接続状態を正常な「手動運用」として伝える表示もない。ここを後方互換に補う。

## 現在の実装状況

| 領域 | 現状 | JRA-VANなし |
| --- | --- | --- |
| アプリ起動 | `main.ts`にJRA-VAN設定検証なし | 動作可能 |
| レース登録 | 手動フォーム、かんたん一括登録、内部CSV | 動作可能 |
| 出走馬登録 | 手動フォーム、内部CSV | 動作可能だが全詳細が必須 |
| パドック評価 | `Assessment`と追記履歴 | 動作可能 |
| 最終予想 | `Prediction`、追記専用`PredictionVersion` | 動作可能 |
| 会員表示 | 公開版とEntitlementから投影 | 動作可能 |
| 結果 | 管理画面下書き、内部CSV、確定版 | 動作可能 |
| 成績 | 確定結果版と公開予想版から保存 | 動作可能 |
| AI Race Guide | 専用モデル、feature flag既定OFF、test/disabled transport | 通常運用を阻害しない |

## JRA-VAN依存箇所

- `tools/jra_van_bridge`: Windows/JV-Link用オフラインbridge。アプリプロセスから呼び出されない。
- `packages/domain/src/races.ts`: JRA-VAN bundle検証と標準`RaceInput`/`EntryInput`への変換。
- `apps/api/src/races.controller.ts`: 検証済みbundleのプレビュー・確定API。
- `packages/domain/src/results.ts` / `apps/api/src/results.controller.ts`: `JRA_VAN_BRIDGE_V1`結果を内部標準結果へ変換する任意provider。
- `apps/web/components/race-manager.tsx`: bundle選択UI。
- `apps/web/components/results.tsx`: 結果provider選択UI。

これらは入力Adapterであり、Prediction、Publication、Result確定、Performanceの実行時依存ではない。

## JRA-VAN未接続時に停止する処理

主要運用を停止する処理は見つからなかった。JRA-VAN bundle専用APIはbundleを明示的に投入した場合だけ検証される。ReadinessにもJRA-VAN接続必須条件はない。

ただし管理画面ではJRA-VAN bundle欄が常時同じ強さで表示され、現在の取得方式や正常状態が分からない。未接続を障害表示はしていないが、「手動運用が正規モード」であることも表示していない。

## Race作成の必須field

現在は開催日、競馬場、番号、名称、クラス、距離、芝/ダート、方向、発走日時、馬場、天候、状態を必要とする。かんたん一括登録は馬場を`UNKNOWN`、天候を`未確認`、状態を`SCHEDULED`、担当を未割当として補完しており、今回の最小入力要件を満たす。

## RaceEntry作成の必須field

現在は馬ID、馬番、枠番、馬名、性別、年齢、斤量、騎手、調教師、状態が必須である。オッズ・人気だけがnullableである。初期運用で必要な「馬番＋馬名」に対して過剰であり、入力負荷と誤った仮入力の原因になる。

対応として、DBの詳細属性をnullableへ緩和し、既存の詳細入力・CSV contractは維持する。簡易登録専用contract/APIでは馬番・馬名だけを受け、Horse IDはサーバー生成する。不明値を0や仮名で保存しない。

## Horse Identity

- `Horse.id`はUUIDで、RaceEntryは名前ではなくUUIDを参照する。
- JRA-VAN bridgeは血統登録番号から決定的UUIDを生成する。
- Phase 1Bの`HorseExternalIdentity`はprovider/hash、照合状態、観測名を保持し、名前一致による自動mergeを禁止できる。

簡易登録では新規Horse UUIDと`provider=MANUAL`の暫定Identityを作る。同名Horseが存在する場合は`POSSIBLE_DUPLICATE`、それ以外は`UNRESOLVED`とし、どちらも自動mergeしない。後日、正式external identityを人が確認して関連付ける余地を維持する。

## CSV Import / かんたん一括登録

- Race/Entry内部CSVは`CsvRaceDataProvider`から共通入力へ変換される。
- かんたん一括登録もブラウザーで標準Race CSVへ変換し、同じプレビュー・競合検証・監査を通る。
- JRA-VAN bundleも同じ内部Race/Entry保存処理へ流れる。
- 結果は`ResultDataProvider` catalogで内部標準CSVとJRA-VAN bridgeを分離している。

既存Adapter境界を維持し、手動経路を別Domainへ複製しない。

## Paddock Prediction / Publication / Results

- AssessmentとPredictionはRaceEntryを参照し、外部providerを参照しない。
- 公開版は追記専用で、初版と訂正版を履歴化する。
- 結果は手入力下書きまたは内部標準CSVで登録でき、人の確定後に追記専用結果版と成績を作る。
- 全出走馬はRaceEntry、三国谷氏が評価する馬はAssessment/Predictionのmarkとして分離済みである。

今回この境界と公開済みデータを変更しない。

## AI Race Guide / Fact Builder

- AI Race Guideは専用flagがすべて既定OFFで、transportは`disabled`が既定である。
- Phase 1B Fact Builderは`UNKNOWN`、`INSUFFICIENT_DATA`、`NOT_AVAILABLE`とEvidence/License Gateを持つ。
- ただしPhase 1Aのsynthetic入力生成サービスは現在RaceEntry詳細を常に`KNOWN`として組み立て、nullableな手動Entryを扱えない。

簡易登録Entryの詳細が不足する場合は、出走馬詳細Factを`INSUFFICIENT_DATA`として値を付けず、馬番・馬名をallowed horseとしてのみ保持する。欠損を不振や苦手へ変換しない。

三国谷氏コメントをBasic Guideへ入力する機能は今回実装しない。将来実装時もORIGINAL/AI_DRAFT/APPROVEDの分離、License Gate、人の承認が必要である。

## Provenance / 監査

- Race/Entry変更は既存AuditLogへactor、role、時刻、理由、before/after、request IDを保存する。
- ImportBatchは確認者、期限、確定時刻、source fingerprintを保持する。
- 簡易手動Horseは`HorseExternalIdentity(provider=MANUAL)`で取得方法を明示し、Identity IDと状態をEntry保存監査へ含める。
- 外部情報を手入力しても自社生成データとみなさない。外部sourceを使う場合の権利区分は既存`DataLicensePolicy`を使用する。

## DB変更の必要性

必要。既存値を変更せず、RaceEntryの次の詳細列だけをnullableへ緩和する。

- `gate`
- `sex`
- `age`
- `carriedWeight`
- `jockey`
- `trainer`

列削除、table削除、backfillは行わない。既存詳細CSV contractは維持する。

## Feature flag / configuration

`RACE_DATA_MODE`を追加し、未設定時は安全な`MANUAL`とする。候補値は`MANUAL`、`CSV`、`JRA_VAN`、`OTHER_PROVIDER`。これは表示とAdapter選択の運用情報であり、Race/Prediction/Resultを停止するgateにはしない。

## ライセンス境界

- MANUALは「入力方法」であってデータの権利帰属を保証しない。
- 外部sourceのStorage/Derived/Display/External AIは既存License Gateで個別判定する。
- 未確認をAPPROVEDにしない。
- 公開Webサイトのスクレイピングは実装しない。

## 推奨実装順

1. `RACE_DATA_MODE` contract・起動検証・管理画面の正常状態表示。
2. RaceEntry詳細列のnullable化と既存画面の欠損表示対応。
3. 馬番＋馬名の簡易登録API/UI、MANUAL暫定Identity、監査。
4. AI structured inputの欠損安全化。
5. Unit、DB/API integration、desktop/mobile E2E、主要予想・結果regression。

## リスク

- nullable属性を既知として扱う既存コードの見落とし。
- 同名Horseの誤merge。自動merge禁止と`POSSIBLE_DUPLICATE`で抑止する。
- 簡易登録後に正式providerを取り込む際の重複。今回は自動統合せず、人の確認を必要とする。
- 手入力情報の出典誤認。MANUALは入力経路のみで、権利承認を意味しないとUI・文書に明示する。
- AIが欠損を評価へ変換する危険。欠損Factに値を持たせずvalidatorで維持する。
