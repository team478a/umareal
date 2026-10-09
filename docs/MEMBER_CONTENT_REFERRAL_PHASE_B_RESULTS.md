# 会員別コンテンツ配信・紹介特典管理 Phase B 実装結果

## 実装情報

- 基準: Phase Aがマージされた`main`（`dfca894d389305796a2482c39c8fc3b110c6c13a`）
- 作業ブランチ: `codex/referral-entitlements-phase-b`
- 実装日: 2026-10-09
- 範囲: 紹介特典設定・付与基盤
- 対象外: 本番deploy、本番migration、初期3/5/10設定の有効化、実会員への付与・通知、Stripe契約作成

## 結論

Phase Bは既存V1を残したadditiveな基盤として実装した。新しい特典定義は初期データを投入せず、管理者が公開と新規付与を明示的に有効化した版だけを、以後の紹介成立時に評価する。既存達成者へ遡及付与しない。

## DB変更

- `ReferralBenefit`: 安定IDとrevision
- `ReferralBenefitVersion`: 条件、種別、数量、期限、配布期間、公開、新規付与、案内、変更理由を追記型で保存
- `ReferralBenefitVersionContent`: LIMITED_CONTENTと既存`ContentItem`の対応
- `ReferralAchievement`: 紹介成立ごとの直前人数、成立後人数、時刻
- `ReferralBenefitGrant`: 会員、適用版、単位番号、獲得内容snapshot、状態、期限、利用先

既存`ReferralMilestone`、`ReferralReward`、`DayPass`、`Entitlement`は削除・変換しない。特典版、対応コンテンツ、達成イベントはDB triggerでUPDATE/DELETE/TRUNCATEを拒否する。特典行はrevisionの1増加だけを許可し、Grantは権利の同一性とsnapshotを変更不可にする。

## 管理機能

`/admin/referrals`で特典の追加、新しい設定版、同じ人数への複数特典、公開・新規付与停止、CMS選択、付与状況を扱う。変更APIはADMIN+AAL2、変更理由、revision、Idempotency-Key、監査ログを必須とする。停止は新規付与だけを止め、既得特典を取消さない。

## 付与と利用

- 閾値を横切った時点だけ付与するため、設定追加後に過去達成者へ付与しない。
- 数量はGrantを単位別に作り、会員・版・単位番号の一意制約で二重付与を防止する。
- DAY_PASSは既存`createDayPassAccess`を使用する。
- MONTHLY_ACCESSは`REFERRAL_MONTHLY_ACCESS`の期間付きEntitlementだけを発行し、Subscriptionを作成・変更しない。有効な有料契約中は既存契約保護のため受取を拒否する。
- LIMITED_CONTENTは有効なGrantと対象`ContentItem`をサーバー判定し、権限がなければ本文とmedia URLを返さない。
- 期限切れ、無効化、二重利用を拒否し、利用APIはIdempotency-Key再送で同じ応答を返す。

## 会員権限

`ContentAccessPolicy`へ後方互換な`referralMonthly`行を追加した。旧JSONに行がない場合は安全な既定値で補完し、管理画面では月額、1日利用、手動付与と別に設定する。無料全文テストやStripe月額契約とは統合しない。

## 既存会員・既存特典への影響

- 既存3人・10人の一日券V1は継続動作する。
- 既存ReferralReward、使用済みDayPass、Entitlementは更新しない。
- migrationに新特典seedを含めない。
- 新特典設定の通常変更を既存達成者へ遡及しない。
- 公開済み予想、CMS公開版、課金契約、通知には変更を加えない。

## テスト範囲

- Domain: 種別固有条件、公開と付与状態、厳格な入力契約
- DB: FK、一意制約、版履歴・達成履歴の追記専用、Grant同一性保護
- Integration: ADMIN+AAL2、同一閾値の複数特典、非遡及、専用Entitlement、Subscription不変、冪等再送、停止版
- Regression: 既存紹介V1、CMS権限、ContentAccessPolicy、全体typecheck/lint/test/build

## Phase Cへ残す事項

- 会員紹介画面へ新旧特典を統合し、進捗・受取・期限を表示
- 1日券の対象日0:00 JST開始と返金表示の整合
- LINE/メール本人確認済み無料会員への通常登録特典統一
- LIMITED_CONTENTの会員向け導線
- desktop/mobile E2E

## 判定

Phase Cへは **CONDITIONAL GO**。Phase BのmigrationとAPIをレビューし、初期特典を有効化しないことを確認した上で進む。本番migration、初期設定作成、実会員付与は別承認とする。
