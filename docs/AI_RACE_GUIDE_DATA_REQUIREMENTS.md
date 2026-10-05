# AIレースガイド データ要件

作成日: 2026-10-05

判定語: `AVAILABLE`、`PARTIAL`、`MISSING`、`LEGAL/DATA LICENSE REVIEW REQUIRED`

## 1. 原則

1. LLMはデータ取得元ではなく、検証済みfactの説明器としてのみ使う。
2. `Race`、`Horse`、`RaceEntry`、`RaceResultVersion`をAI用に複製しない。
3. 値にはsource、source version、観測時刻、data cutoffを結びつける。
4. 不明値は `UNKNOWN`、母数不足は `INSUFFICIENT_DATA`、提供対象外は `NOT_AVAILABLE` とする。
5. 権利区分が未確認のfieldはfact builderと外部AI送信の両方で拒否する。
6. 公開済みsnapshotは後着データ・結果で上書きしない。

## 2. V1必要データ一覧

「AI送信」は技術上の可否ではなく、権利・契約確認後にallowlistへ入れられるかを示す。JRA-VAN由来は一律で事前確認が必要である。

| データ | 現在 | 保存先 | 追加取得候補 | AI送信 | 更新タイミング |
| --- | --- | --- | --- | --- | --- |
| 開催日・場・R・名称・発走 | AVAILABLE | `Race` | RA | 要権利確認 | 開催登録・変更時 |
| クラス・距離・芝ダート・回り | AVAILABLE | `Race` | RA | 要権利確認 | 開催登録・変更時 |
| 天候・馬場 | AVAILABLEだが単一snapshot | `Race` | RAまたは許諾済みfeed | 要権利確認 | 発表・変更時 |
| 出走馬・馬番・枠 | AVAILABLE | `RaceEntry` | SE | 要権利確認 | 出馬表・取消時 |
| 性齢・斤量 | AVAILABLE | `RaceEntry` | SE | 要権利確認 | 出馬表・変更時 |
| 騎手・調教師 | AVAILABLE | `RaceEntry` | SE | 要権利確認 | 乗替り等変更時 |
| 単勝オッズ・人気 | PARTIAL。現在値/最終値のみ | `RaceEntry`、result | 時系列odds | 要権利確認 | 時系列またはcutoff時 |
| 確定着順・異常・取消 | AVAILABLE | `RaceResultVersion` | final SE | 要権利確認 | 結果確定・訂正時 |
| 払戻 | 既存result snapshotに関連項目あり | result version | provider result | 要権利確認。V1 AI入力不要 | 結果確定時 |
| 馬の横断ID | PARTIAL。JRA-VAN取込は決定的UUID | `Horse.id` | external identity registry | 原識別子送信は原則不要 | 取込時 |
| 血統 | MISSING | なし | JRA-VAN馬master等 | 要権利確認 | 馬master訂正時 |
| 網羅的な過去走 | PARTIAL。DBに取り込んだRaceのみ | Race/Entry/Result | 過去RA/SE等 | 要権利確認 | 結果確定・訂正時 |
| 走破時計・着差・通過順・上がり | MISSING | なし | JRA-VAN候補 | 要権利確認 | 結果確定・訂正時 |
| 馬体重・増減 | MISSING | なし | JRA-VAN候補 | 要権利確認 | 当日発表時 |
| 調教・追切 | MISSING | なし | JRA-VAN候補 | 要権利確認 | 調教情報更新時 |
| コース特性master | MISSING | なし | 許諾済みmaster/自社rule | 出典により判定 | 低頻度version更新 |
| 条件別集計 | MISSING | なし | 許諾済み過去走から決定計算 | 派生利用も要確認 | source追加・rule更新時 |
| 三国谷パドック評価 | AVAILABLE | Assessment/version | 自社データ | V1事前生成では送らない | 評価保存時 |
| 三国谷最終評価 | AVAILABLE | PredictionVersion | 自社データ | V1事前生成では送らない | 公開・訂正時 |

## 3. AIレースガイド項目別の成立条件

| ガイド項目 | 必須fact | 現状判定 | V1方針 |
| --- | --- | --- | --- |
| レース概要 | Race条件、時刻 | AVAILABLE | 既存データで構成候補。ただし表示・AI送信の権利確認は必要 |
| データ上の注目材料 | 条件別比較、根拠母数 | MISSING/PARTIAL | 母数を満たす項目だけ表示 |
| 注目馬候補 | 複数の許諾済み比較fact | PARTIAL | 内部ruleが成立する場合のみ。買い目表現禁止 |
| プラス材料 | 過去走・適性・血統等 | PARTIAL | 根拠ID必須 |
| 注意材料 | 同上 | PARTIAL | 不足を不利材料と誤認しない |
| コース適性 | 網羅的過去走、コース定義 | MISSING | データ整備まで `INSUFFICIENT_DATA` |
| 距離適性 | 網羅的過去走、距離bucket | MISSING/PARTIAL | 最低出走数をlogic versionで固定 |
| 馬場適性 | 過去走、馬場定義 | MISSING/PARTIAL | 馬場不明・サンプル不足を分離 |
| 血統参考情報 | pedigree master、説明rule | MISSING | 許諾・master整備後 |
| 近走内容 | 過去走の網羅性 | PARTIAL | 「DB内直近」を全成績と表現しない |
| 展開参考情報 | 脚質根拠、枠、頭数等 | MISSING/PARTIAL | V1で脚質を自由推定しない |
| レース難易度 | data completeness、評価差 | PARTIAL | 的中難易度でなく情報差を表示 |
| パドック確認点 | 事前factからの観察項目rule | PARTIAL | 診断せず「確認したい点」に限定 |
| 振り返り | 公開guide version、確定result version | AVAILABLE/PARTIAL | PRE_RACEとは別version。V1後半候補 |

## 4. 決定的計算の要件

各計算は入力field、最低母数、除外条件、丸め、同点、欠損、rule versionをコードとtestで固定する。

例:

- 距離適性: 距離bucket、完走扱い、対象期間、最低出走数を固定
- 馬場適性: 馬場codeの対応、取消・競走中止の除外を固定
- 近走: 「直近N走」の基準日を `dataCutoffAt` とし、結果後の混入を防止
- 情報差: 入力coverageと複数指標の分散を使い、勝率には変換しない
- 注目材料: ruleが作ったfactを列挙し、LLMに選別計算させない

内部scoreを設けても、統計的な勝率として校正されていない限り会員へ確率表示しない。

## 5. Provenance要件

現行bundle manifestには件数・hash・format versionがあるが、正規化後の各Race/Entry fieldから元recordへの恒久的な参照は十分でない。AI入力snapshotには最低限次を保存する。

- source providerと契約上の利用区分
- import batch / manifest / source record reference
- source schema version、record version、訂正番号（提供される場合）
- observed/fetched/imported timestamp
- fieldごとのevidence ID
- canonical input hash
- data cutoff
- fact builder / logic version

raw sourceを無期限保存するという意味ではない。ライセンス上の保存制限と監査要件を両立する保持方針を先に決める。

## 6. JRA-VAN等からの取得候補

次は調査backlogであり、利用可能との判定ではない。

| 候補 | 技術調査 | 契約・権利調査 |
| --- | --- | --- |
| 馬master・血統 | record種別、キー、訂正、文字コード | 商用表示、派生説明、保存期間 |
| 過去走 | 取得範囲、初回backfill、差分、取消 | 履歴保存、集計・二次利用 |
| 調教 | record定義、更新頻度、欠測 | 有料表示、要約、外部処理 |
| オッズ | snapshot間隔、確定値、量 | 再配信、履歴保存、遅延条件 |
| 馬体重 | 発表時刻、訂正、取消 | 表示・派生利用 |
| 成績詳細 | 通過順、時計、着差、上がり | 集計・会員表示・保持 |

全行を **LEGAL/DATA LICENSE REVIEW REQUIRED** とする。既存Data Lab利用契約と、法人・サービス提供向け契約のどちらが適用されるかも確認する。

## 7. 外部AIへ送信可能かの確認票

外部provider採用前に、データ項目ごとに次を承認する。

- source licenseが第三者処理・国外移転・機械処理を許可する
- providerが入力をモデル学習へ使わない契約である
- retentionを0または承認期間に設定できる
- processing regionとsubprocessorを把握している
- incident、削除、監査、契約終了時の扱いが定義されている
- 馬・レース以外の個人情報や内部コメントを除去している
- 送信allowlistとpayload logに秘密情報が含まれない

1項目でも未確認ならそのsourceを外部AIへ送らない。代替は決定的template renderer、許諾済みデータだけの縮小版、または承認済み閉域modelである。

## 8. 三国谷データとの将来分析に必要な補足

現在の構造でrace/entry/horse単位の結合は可能だが、分析品質のために次が不足する。

- `calm` を発汗と落ち着きへ分けるかの業務判断
- 評価不能0と未入力nullの集計規約
- assessment versionとprediction versionの採用時点
- 公開前/公開後訂正を区別するcutoff
- 取消、除外、競走中止、見送りの共通定義
- AI事前guide version、最終prediction version、result versionの明示的な分析link

これらを整備しても、新しい予測modelを作ることは本計画の範囲外である。

## 9. 更新タイミング案

| 時点 | 処理 |
| --- | --- |
| 出馬表確定後 | Race/Entry取込、source validation |
| 前日所定時刻 | 最初のfact snapshotとAI説明生成 |
| 取消・乗替り・馬場等の更新 | stale判定。自動公開せず再生成候補にする |
| 公開直前 | source revision、input hash、cutoffを再確認 |
| 発走後 | PRE_RACE生成・公開を停止 |
| 結果確認後 | 確定ResultVersionを使う別の振り返り生成 |
| 結果訂正後 | 元振り返りを保持して訂正版versionを作成 |

時刻は運用会議で決め、timezoneを `Asia/Tokyo` に固定して保存時はUTC instantを使用する。

## 10. Phase 1開始前のデータGate

- [ ] V1で使用するfield allowlistが確定
- [ ] 各fieldにsource、保持、表示、派生、外部AI送信の判定がある
- [ ] JRA-VANに必要な許諾が文書化されている
- [ ] 過去走coverageと最低母数が定義されている
- [ ] unknownと0、未入力、対象外を区別できる
- [ ] source訂正時のstale/再生成規則が決まっている
- [ ] providerの学習利用・retention・regionが承認されている
- [ ] 三国谷氏の非公開データをV1 payloadに含めないことが確認されている
