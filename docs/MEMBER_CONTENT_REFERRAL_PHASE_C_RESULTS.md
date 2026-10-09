# 会員別コンテンツ配信・紹介特典管理 Phase C 実装結果

## 実装情報

- 基準main: `1f4447bd1d88eb79d6651c5f211f889911799e1c`
- 作業ブランチ: `codex/referral-entitlements-phase-c`
- 実装日: 2026-10-09
- 範囲: 会員紹介画面、特典利用導線、限定CMS権限確認、1日券開始条件、通常登録特典統一
- 対象外: KPI集計、本番deploy、本番migration、初期特典の有効化、実会員への遡及付与・通知、Stripe契約変更

## 結論

Phase Bで追加した可変特典を既存の3人・10人一日券と同じ会員画面へ統合した。会員は現在の紹介人数、公開中の特典、次の特典までの残数、獲得済み・使用済み・期限切れの状態を確認できる。新しい特典設定は引き続き自動作成・自動有効化されず、既存会員への遡及付与も行わない。

## 会員画面

- 紹介URLと紹介コードを別々に表示・コピーできる。
- 公開中の可変特典をDB設定から表示し、必要紹介人数、種別、数量、期間、案内文、付与停止状態を固定値なしで反映する。
- 既存Rewardと新しいGrantを併記し、従来特典を削除・変換しない。
- `DAY_PASS`は会員が対象日を選んで利用開始する。
- `MONTHLY_ACCESS`は明示操作で利用開始し、Stripe Subscriptionを作成・変更しない。
- `LIMITED_CONTENT`は有効なGrantに関連し、現在公開中のCMSコンテンツだけへ導線を表示する。
- 使用済み、期限切れ、無効化済み特典を履歴として確認できる。
- desktopとiPhone相当幅で横スクロールが発生しないことを確認した。

## APIと権限

- `GET /me/referral-benefit-program`を追加し、会員本人へ公開中の設定、進捗、本人のGrantを会員向け項目だけ返す。
- レスポンスへメール、内部メモ、外部ID、限定本文、media URLを含めない。
- 特典利用はPhase Bの所有権、状態、期限、Idempotency-Key、競合制御を再利用する。
- LIMITED_CONTENTは紹介画面のリンク表示だけで権限を確定せず、既存CMS APIが本文・media URL返却前にGrantと公開状態を再検証する。

## 1日券の開始条件

- WIN5初版が対象日前に公開済みなら、既存どおり公開時刻から有効にする。
- WIN5未公開でも、対象日0:00 JST以後はworkerがPENDING券をACTIVEにし、DAY_PASS Entitlementを作成する。
- 対象日中に交換・購入した券はその時点で有効になる。
- 終了は対象日の翌日0:00 JSTの排他的終端を維持する。
- worker再実行でも二重Entitlementや二重監査を作らない。

### 返金条件への影響

対象日開始で有効化された購入一日券は、既存の「WIN5未公開のまま一度も利用開始しなかった期限切れ購入券」という管理者返金候補条件に該当しなくなる。利用開始済み券、紹介券、月額契約を自動返金・取消ししない既存方針は維持した。対象日途中の公開中止等に対する新しい返金判断はPhase Cへ追加していない。

## 通常登録特典

- 対象をLINE登録MEMBER、またはメール確認済みMEMBERへ統一した。
- 未確認メール会員、スタッフ、未認証者には一覧・動画URLを返さない。
- 一覧には動画URLを含めず、本人の個別視聴操作時だけ返す既存境界を維持した。
- 既存の会員・特典別視聴履歴とファネルイベントを変更しない。
- 紹介達成限定コンテンツ、無料全文テスト、月額権限とは統合しない。

## DB変更

Phase CのDB migrationはない。Phase Bのモデルと既存DayPass、Entitlement、CMS、登録特典テーブルを再利用した。

## 主な変更箇所

- `packages/domain/src/referrals.ts`: 会員向け可変特典プログラム契約
- `apps/api/src/referral-benefits.service.ts`: 会員向け進捗・Grant projection
- `apps/api/src/referrals.controller.ts`: 会員向けプログラムAPI
- `apps/api/src/day-pass-access.ts`: 対象日中の即時開始
- `apps/worker/src/day-pass-activator.ts`: 対象日開始時の未開始券有効化
- `apps/api/src/free-reports.controller.ts`: LINE・メール確認済み会員の共通対象判定
- `apps/web/components/referrals.tsx`: 新旧特典、利用、履歴、限定CMS導線
- `apps/web/components/free-reports.tsx`, `apps/web/components/media-app.tsx`: 共通登録特典表示

## 検証結果

- 全Unit: 97ファイル、526件 PASS。配備補助スクリプト20件もPASS
- 全Integration: 46ファイル、164件 PASS。Stripe専用transportの13件は通常test transportジョブの設計どおりskip
- Referral integration: 16件 PASS
- Billing integration: 9件 PASS
- Registration benefit integration: 4件 PASS
- Content integration: 1件 PASS
- 対象E2E desktop/mobile: 10件 PASS
- 全workspace typecheck / lint / production build: PASS
- 外部通知、外部決済、本番環境への通信: なし

CIのfresh PostgreSQLでも同じ検証を実行し、PRの最終判定へ反映する。

## 既存会員・既存特典への影響

- 既存3人・10人Reward、利用済みDayPass、Entitlement、視聴履歴を更新しない。
- 新特典をseedまたは有効化しない。
- 可変特典を過去の達成者へ遡及付与しない。
- 公開済み予想、CMS公開版、Stripe契約、通知設定を変更しない。

## Phase Dへ残す事項

- 期間指定KPI: 紹介登録、成立、設定別達成者、付与、利用、期限切れ
- 紹介特典からの有料申込と月額体験終了後の有料化の帰属定義・集計
- 全結合・E2E・セキュリティ回帰の最終確認
- 管理者向け運用手順と初期3/5/10設定のcutover手順
- 本番migration、初期設定作成、実会員付与、通知、deployは別承認

## 判定

Phase C単体は **GO**。Phase DではKPIの事業定義を確定した上で集計と総合検証を独立PRとして実施する。本番反映はPhase D完了後も別承認とする。
