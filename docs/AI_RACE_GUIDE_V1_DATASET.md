# AIレースガイド V1最小データセット

作成日: 2026-10-05

## 結論

V1は「現在レース＋出走馬基本情報＋直近10走（最大24か月）」で成立させる。血統、調教、現在馬体重、時系列オッズ、詳細時計はV1必須にしない。

この構成で、現在のDeterministic Fact Builderが提供するレース概要、直近成績、距離・競馬場・馬場・芝ダート・同等クラスの事実集計、データ充足度を生成できる。三国谷氏が当日の馬を見る価値を中心に残し、AI側の情報量だけを増やさない。

## 必須データ

### 現在レース

- 開催日、競馬場、番号、名称、クラス
- 芝/ダート、距離、回り、馬場状態、天候
- 発走時刻、頭数
- source revision、observed/imported時刻、license policy version

### 出走馬

- Horse ID、RaceEntry ID、馬名、性齢
- 枠番、馬番、斤量、騎手、調教師、出走状態
- source revision、observed/imported時刻、license policy version

### 過去走

- 開催日、競馬場、芝/ダート、距離、馬場状態、クラス
- 確定着順、異常区分
- source revision、結果確定時刻、observed/imported時刻

過去人気・最終単勝オッズは取得できれば表示材料に加えられるが、V1成立条件には含めない。欠損時は`UNKNOWN`とし、推測しない。

## 過去走範囲

各馬について、`dataCutoffAt`以前に確定した平地レースを次の順で選ぶ。

1. 対象レース自身を除外する。
2. 取消・除外・レース中止は成績集計から除外する。競走中止はRecent Formの事実として残し、平均着順等から除外する。
3. 過去24か月以内を対象にする。
4. 新しい順に最大10走を保持する。
5. Recent Formはそのうち直近5走を表示する。
6. 条件別Factは最低3走を必要とし、3走未満は`INSUFFICIENT_DATA`とする。

直近5走だけでは複数の条件別Factで3件を確保しにくい。全競走歴は量・古さ・権利・訂正管理の負担が大きい。最大10走かつ24か月は、Fact Builderに必要な最小範囲として採用する。

新馬・キャリアの浅い馬は0〜2走でも、providerが対象期間を完全検索したことを証明できればcoverage自体は`COMPLETE`になり得る。Fact stateは別に`UNKNOWN`または`INSUFFICIENT_DATA`とする。

## Completeness

source coverageとFact stateを混同しない。

### COMPLETE

- 現在レース・全出走馬の必須fieldが取得済み
- providerの対象期間・対象recordを最後まで処理済み
- 各馬について24か月またはデビュー以降の短い方を検索済み
- 最大10走までの確定結果が揃い、revision/cutoffを検証済み
- 0走の場合も「取得失敗」ではなく「対象走なし」を証明できる
- 利用する全fieldのStorage/Derived/Displayが`APPROVED`

### PARTIAL

- source処理は完了したが、一部馬・field・期間・訂正版が不足
- 取得対象走はあるが必須fieldが欠ける
- 一部sourceだけlicense gateを通過していない

### UNKNOWN

- provider query/bundleが未完了、失敗、期限切れ、または対象期間を証明できない
- source revisionやimport batchが追跡できない
- 「0件」と「取得不能」を区別できない

`PARTIAL`や`UNKNOWN`でもレース概要を表示できる場合はあるが、完全な過去成績と表現しない。Factごとに`KNOWN / UNKNOWN / INSUFFICIENT_DATA / NOT_AVAILABLE`を維持する。

## V1から外すもの

| データ | 判断 | 理由 |
| --- | --- | --- |
| 現在単勝オッズ・人気 | 任意 | 変動が速くcutoff/revision運用が増える。市場評価をAI推奨に見せない |
| 現在馬体重・増減 | 任意 | 有用だが直前更新と保存model追加が必要。三国谷パドックの補助として後続追加可能 |
| 走破時計・着差・上がり・通過順位 | Phase 2候補 | Fact rule、欠損コード、コース差補正を追加しないと誤読しやすい |
| 血統 | Phase 2候補 | V1のRecent/条件Factに必須でなく、取得・license・サンプル数・説明検証が増える |
| 調教・追切 | Phase 2以降 | 三国谷氏の当日観察と役割が近く、取得時点・計測欠損・解釈ルールが複雑 |
| 時系列オッズ | Phase 2以降 | 大量更新・保存・再配信条件・市場情報の説明境界が必要 |
| 高度な騎手/調教師/血統統計 | 将来 | V1の最小価値に不要 |

## 外部AIが利用できない場合

V1は外部AIなしでも成立する。

1. Deterministic Fact Builderの表・箇条書きをそのまま表示する。
2. 固定Template RendererでFact stateと数値だけを日本語化する。
3. 外部AIが許可されたsourceのFactだけを別payloadへ投影する。
4. 将来、閉域または自社管理modelを検討する。

当面の推奨fallbackは1と2である。表示内容が決定的で、監査・再現・訂正が容易なためである。
