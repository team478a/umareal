# 手動運用 安定化 Phase 2 実装結果

作成日: 2026-10-06

## ゴール

JRA-VAN未接続の初期運用で、簡易登録した暫定馬を人が安全に確認でき、Basic Guideが登録済みの基本情報を欠損・状態を含めて正確に表示できるようにする。

## Horse Identity確認

- 管理画面のレース管理に、`MANUAL`かつ`UNRESOLVED` / `POSSIBLE_DUPLICATE`のIdentity確認欄を追加した。
- 同名Horseだけを既存馬候補として表示する。
- 人が「既存馬へ紐付け」または「別の馬として確定」を選び、理由を必須入力する。
- 名前一致による自動mergeは行わない。
- 確定時に変更するのは`HorseExternalIdentity.horseId`と`matchStatus`だけである。
- 既存RaceEntryの`horseId`、Assessment、Prediction、公開版、結果は変更しない。
- 判断、変更前後、理由、actor、時刻、request IDを追記専用AuditLogへ保存する。

## Basic Guide拡張

登録済みのRace/RaceEntry Factから、次を固定テンプレートで表示する。

- 開催日とJST発走時刻
- 右回り / 左回り / 直線
- 馬場状態
- 天候
- 開催予定 / 進行中 / 延期 / 終了 / 中止
- 出走予定 / 取消 / 除外 / 競走中止

未確認値は「未確認」と表示し、推測しない。出走馬詳細の不足は引き続き`INSUFFICIENT_DATA`であり、成績不振とは扱わない。

## 境界

- DB migrationなし。
- JRA-VAN追加取得なし。
- 外部AI通信なし。
- 自動Horse mergeなし。
- 本番deploy / 本番migrationなし。

## バージョン

- Basic Guide logic: `basic-guide-rules-v2`
- Basic Guide template: `basic-guide-template-v2`
- Template provider: `deterministic-template-v2`

## 残る制約

- Identity確定後の訂正は専用UIをまだ持たない。誤操作時は監査ログを確認し、次フェーズで追記型訂正フローを設計する。
- 名前が異なる既存Horseへの紐付けは安全のため許可しない。
- 正式Provider identityとの照合は契約・Provider導入後に行う。
