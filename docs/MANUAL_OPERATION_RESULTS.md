# JRA-VAN未接続 初期運用 実装結果

作成日: 2026-10-06
基準main: `e2740470e90004ff533ebd1cf4c7163ba80f0837`
作業branch: `feat/manual-race-operation-mode`

## 実装内容

- `RACE_DATA_MODE`を追加。未設定時は`MANUAL`であり、JRA-VAN設定を起動条件にしない。
- 管理画面に「データ取得方式: 手動運用」「状態: 正常」「外部データ連携: 未使用」を表示。
- JRA-VAN bundle取込は削除せず、手動モードでは任意の外部Provider欄として折りたたむ。
- 馬番・馬名・理由だけで出走馬を簡易登録できるAPI/UIを追加。
- 不明な枠番、性別、年齢、斤量、騎手、調教師はNULLのまま保存し、画面では「未確認」と表示。
- 簡易登録Horseへサーバー生成UUIDと`MANUAL`暫定Identityを付与。
- 同名Horseは`POSSIBLE_DUPLICATE`として通知し、名前だけで自動mergeしない。
- actor、時刻、理由、Entry、Identity、同名候補を既存AuditLogへ記録。
- AI structured inputは詳細不足Entryを`INSUFFICIENT_DATA / ENTRY_DETAILS_NOT_REGISTERED`とし、仮の属性を生成しない。
- 既存の内部CSV、JRA-VAN bundle、パドック、公開版、結果、成績、AI feature flagを維持。

## DB変更

Migration: `202610060003_manual_race_operation`

`race_entries`の次の列をnullableへ緩和した。

- `gate`
- `sex`
- `age`
- `carriedWeight`
- `jockey`
- `trainer`

既存値の更新、削除、backfill、table削除はない。ローカルPostgreSQLへ全migrationを適用して成功した。本番migrationは未実施。

## 運用フロー

```text
手動レース登録
  ↓
全出走馬を馬番＋馬名で簡易登録
  ↓
必要に応じて詳細を補完
  ↓
三国谷パドック評価
  ↓
予想の確認・公開（追記専用version）
  ↓
会員表示
  ↓
結果下書き・人による確定
  ↓
成績保存
```

RaceEntry（全出走馬）とAssessment/Prediction mark（三国谷氏の評価対象）は既存どおり別概念である。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| Prisma generate / local migration | PASS |
| typecheck | 5 workspace PASS |
| lint | PASS、警告なし |
| Unit / script tests | 82 files、464 tests + Node 20 tests PASS |
| Race/Prediction/Result integration | 18 tests PASS |
| AI Race Guide integration（test transport） | 3 tests PASS |
| Race/Prediction E2E desktop/mobile | 10 tests PASS |
| AI Race Guide E2E desktop/mobile | 2 tests PASS |
| JRA-VAN bridge regression | 22 tests PASS |
| build | 5 workspace PASS |

確認した主要Scenario:

1. JRA-VAN環境変数、SDK、JV-LinkなしでWeb/API起動。
2. 手動レース作成とかんたん一括登録。
3. 馬番＋馬名だけの出走馬登録、NULL保持、暫定Identity、同名候補の非merge。
4. パドック入力と予想公開の既存desktop/mobile E2E。
5. 公開予想の会員投影と追記専用version。
6. 手動結果下書き・結果確定・成績保存のintegration。
7. 詳細不足時にAI Factへ値を付けず`INSUFFICIENT_DATA`とすること。
8. 手動運用を管理画面で正常状態として表示。
9. 既存JRA-VAN bundle取込のAPI/E2E/bridge testが継続成功。

## 外部通信・本番操作

- JRA-VAN追加取得、ライブ疎通、実データbackfillは未実施。
- OpenAI、Anthropic、Gemini等の外部AI通信は未実装・未実行。
- AI検証は決定的な`test` transportだけを使用。
- Web scrapingは未実装。
- 本番deploy、本番migration、feature flag有効化は未実施。

## 今回未実装

- AIを使わないBasic Guideの固定template renderer。
- 三国谷氏コメントのAI整理。ORIGINAL/AI_DRAFT/APPROVEDと送信許諾の追加設計が必要。
- 暫定Horseと正式external identityを人が照合・統合する管理UI。
- 正式外部ProviderのライブAdapter。
- リアルタイムオッズ、血統、調教、勝率、買い目、自動公開。

## 判定

ローカル/CI相当の技術判定は **GO**。JRA-VAN未接続を正常な手動運用として、主要サービスを開始できる構造になった。

本番反映はDB migrationを含むため、通常のrelease gate、バックアップ確認、staging確認、別途の本番承認が必要である。
