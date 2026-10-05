# AIレースガイド Phase 1A 完了記録

作成日: 2026-10-05

基準main: `ad52fcd84b6182be4e1b299d57438fe8bcb95a43`

## 結果

外部AIを使用せず、synthetic fixtureだけで「生成 → 検証 → 管理者確認 → 公開 → 会員表示」を行う基盤を実装した。三国谷パドックの既存データは生成入力に使用せず、会員画面では三国谷パドックを先、AIレースガイドを後に表示する。

## 実装範囲

- `AiRaceGuide`、`AiRaceGuideGeneration`、`AiRaceGuideVersion`、`AiRaceGuideVersionHorse`
- 生成試行・公開版・公開版と馬の関連のPostgreSQL追記専用保護
- `disabled` / `test` provider。testは決定的で外部HTTP通信を行わない
- Fact / Evidence、入力hash、data cutoff、logic/prompt/source/model versionの保存
- 禁止表現、未知のFact/Evidence/entry、入力にない数値のvalidator
- 生成、状態取得、承認、公開、訂正開始の管理API
- ADMIN+AAL2、CSRF、revision、idempotency、auditの既存方式の再利用
- FREE_PREVIEW / PAID_FULLをサーバー側で分離する会員API
- 既存Entitlementの月額、1日利用、手動付与による全文閲覧
- synthetic fixtureのFact/Evidence、検証結果、preview/fullを確認する管理画面
- レース詳細の三国谷パドック後・結果前に表示する会員カード
- 有料全文の既存会員透かし

## Feature Flags

全て未設定時は停止する。

- `AI_RACE_GUIDE_ENABLED=false`
- `AI_RACE_GUIDE_GENERATION_ENABLED=false`
- `AI_RACE_GUIDE_PUBLICATION_ENABLED=false`
- `AI_RACE_GUIDE_TRANSPORT=disabled`

`test` transportはproductionでは拒否する。`ENABLED=false`ではAPIを404にし、管理メニュー導線を表示しない。

## 安全境界

- `Assessment`、`AssessmentVersion`、`Prediction`、`PredictionVersion`、三国谷コメントを入力しない
- JRA-VAN実データを使用・追加取得しない
- OpenAI、Anthropic、Google、その他外部AI/APIへ送信しない
- 勝率、的中率、期待利益、買い目、券種、購入金額、自動投票、保証表現を拒否する
- validation failure、stale、発走後、Feature Flag停止中は公開しない
- 公開済み版を修正せず、新しいgeneration/versionとして訂正する

## 検証

- fresh PostgreSQLへ全migration適用成功
- Domain unit: provider、validator、projection、flags、canonical input hash、時刻順序、未知参照を検証
- Integration: 生成、承認、公開、RBAC、AAL2、CSRF、idempotency、audit、無料preview、有料full、stale、validation failure、DB不変性を検証
- E2E: desktop/mobileで管理者フロー、会員表示、三国谷パドック優先順、横スクロールなしを検証
- typecheck、lint、buildを実行

最終的な全リポジトリCI結果はPR上のGitHub Actionsを正とする。

## 未実装

- 外部LLM providerと外部AI送信
- 実JRA-VAN、血統、過去走、調教の追加取得・AI利用
- 非同期worker
- 自動公開、公開予約、LINE通知
- HORSE CARD、レース後AI振り返り、AI予測モデル
- production deploy、production migration

## Phase 1B判定

`CONDITIONAL GO`。Phase 1Aの基盤は次段階へ進める状態だが、Phase 1B開始前にJRA-VAN等の保存・加工・商用表示・外部AI送信の利用許諾を確定し、別途承認を得ること。
