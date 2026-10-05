# AIレースガイド Deterministic Fact Builder

作成日: 2026-10-05

## 責務

Fact BuilderはLLMではなくTypeScriptの決定的処理で、許諾済み競馬データをEvidence付きFactへ変換する。勝ち馬、勝率、的中率、買い目、金額、パドック状態を生成しない。

```text
Race / Horse / RaceEntry / RaceResultVersion
  → license gate
  → dataCutoffAt固定
  → result version選択
  → 決定集計
  → Fact + Evidence + Coverage
  → allowlist projection
  → Phase 1A AiRaceGuideStructuredInput
```

## Fact構造

全Factは次を持つ。

- `state`: `KNOWN` / `UNKNOWN` / `INSUFFICIENT_DATA` / `NOT_AVAILABLE`
- `value`: KNOWNの場合だけ
- `evidenceIds`
- `sampleSize`
- `dataCutoffAt`
- `logicVersion`

適性の断定値は作らず、出走数、1着数、3着以内、平均着順、対象条件を返す。

## V1 Fact

| Fact | 内容 | 最低母数 |
| --- | --- | ---: |
| RACE_OVERVIEW | 対象レース条件 | 1 |
| RECENT_PERFORMANCE | cutoff前の直近5走 | 1 |
| DISTANCE_SUITABILITY | 同一距離の事実集計 | 3完走 |
| COURSE_SUITABILITY | 同一競馬場の事実集計 | 3完走 |
| GOING_SUITABILITY | 同一馬場状態の事実集計 | 3完走 |
| ATTENTION_MATERIAL / surface | 同一芝ダートの事実集計 | 3完走 |
| ATTENTION_MATERIAL / class | 同一クラスの事実集計 | 3完走 |
| PEDIGREE_REFERENCE | 父・母・母父の参照情報 | 1、ただし本番未取得 |
| RACE_COMPLEXITY | データ充足数 | 条件評価ではなく件数表示 |

最低母数は `phase1b-fact-rules-v1` として固定する。変更時はlogic versionを上げ、過去snapshotを上書きしない。

## 取消等の規則

- `WITHDRAWN`、`EXCLUDED`、`CANCELED`: recent form・条件別完走母数から除外
- `DNF`: recent formの状態として表示可能だが、平均着順や条件別完走母数へ含めない
- レース中止: 全走を条件集計から除外
- 結果訂正: cutoff以前に確定した最大versionだけを使用

これらの判断をLLMへ委ねない。

## Future Data Leakage防止

採用条件を全て満たすデータだけを使う。

1. 過去レースの発走時刻が対象レースより前
2. `resultConfirmedAt <= dataCutoffAt`
3. `observedAt <= dataCutoffAt`
4. `importedAt <= dataCutoffAt`
5. 対象レース自身ではない
6. 同一race/horseの結果版はcutoff時点の最新版1件

結果がDBへ後から追加・訂正されても、古いcutoffの再現結果は変わらない。

## Phase 1A接続とAllowlist

`projectFactBundleToStructuredInput`だけがPhase 1A contractへ変換する。出力対象はentries、許可source、Evidence、Factとversion metadataに限定する。

以下のkeyは再帰検査で拒否する。

- Assessment / AssessmentVersion
- Prediction / PredictionVersion
- 三国谷コメント相当
- User / Member / Administrator
- internal memo

`EXTERNAL_LLM` projectionは、使用する全sourceの `externalAiUse=APPROVED` が揃わない限り拒否する。Phase 1Bではこのmodeを使用せず、外部HTTP実装も追加しない。

## Synthetic Fixture A〜H

- A: 3件の十分な過去走
- B: 過去走1件で `INSUFFICIENT_DATA`
- C: 過去走なしで `UNKNOWN`
- D: 同名Horseを `POSSIBLE_DUPLICATE`
- E: 取消馬を集計から除外
- F: cutoff前の結果訂正版だけを選択
- G: cutoff後に追加された結果を除外
- H: `LICENSE_REVIEW_REQUIRED` sourceをFactへ使用しない
