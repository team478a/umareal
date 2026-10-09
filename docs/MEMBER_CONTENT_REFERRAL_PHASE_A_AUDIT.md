# 会員別コンテンツ配信・紹介特典管理 Phase A 監査

## 1. 監査情報

- 基準ブランチ: `main`
- 基準コミット: `21fe08b145635826e2f9e7c782f71649207b1f17`
- 監査日: 2026-10-09
- 対象: 紹介制度、Entitlement、1日利用、CMS、登録特典、課金、管理画面、監査、関連テスト
- この文書の範囲: 読み取りと設計のみ。DB migration、API/UI変更、本番操作は行わない。

## 2. 結論

Phase Bへは **CONDITIONAL GO** とする。

紹介成立、重複防止、1日利用権、Entitlement、CMS本文のサーバー側制御、AAL2、監査ログなどは再利用できる。一方、現在の紹介特典モデルは「達成人数ごとに一つの一日券特典」に限定され、設定履歴、同一人数の複数特典、期間限定月額相当権限、限定CMS、遡及防止を表現できない。既存テーブルの意味を上書きせず、版管理された特典定義と獲得時点のスナップショットを追加する必要がある。

Phase B着手前に、[事業判断が必要な事項](#12-事業判断が必要な事項)を確定する。未確定事項をコードへ推測で固定しない。

## 3. 現在の実装

| 領域 | 現状 | 判定 |
| --- | --- | --- |
| 紹介コード・URL | `users.referralCode`を正本とし、登録経路で紹介関係を保存 | 再利用 |
| 紹介成立 | メール確認またはLINE登録完了で`Referral`を`QUALIFIED`へ遷移 | 再利用 |
| 重複・自己紹介 | `referredUserId`一意制約、自己参照拒否、トランザクションとロックあり | 再利用・拡張テスト必要 |
| 特典設定 | `ReferralMilestone`。必要人数は一意、種別は`DAY_PASS`のみ | 要再設計 |
| 初期特典 | 3人と10人で一日券1枚、有効期間60日 | 既存権利として保持 |
| 特典付与 | `ReferralReward`を会員・milestoneごとに一意作成 | 再利用概念、モデル拡張必要 |
| 特典利用 | 会員が対象日を選び、既存`DayPass`・`Entitlement`を作成 | 再利用 |
| 紹介管理 | `/admin/referrals`でKPI、一覧、詳細、無効化 | 拡張 |
| 会員紹介画面 | URL、成立人数、次の目標、特典履歴、対象日選択 | 拡張 |
| 月額閲覧 | `Subscription`と期間付き`Entitlement` | `Entitlement`のみ再利用 |
| コンテンツ制御 | `ContentAccessPolicy`とAPI側判定。CMS本文・media URLは拒否時に返さない | 再利用・行追加 |
| CMS | `ContentItem`と追記型`ContentVersion`、記事・動画・音声 | 再利用 |
| 登録特典 | `FreeMemberBenefit`。現状はLINE新規登録会員だけ | 対象判定を変更 |
| 無料全文テスト | 紹介特典とは別の設定・判定 | 分離維持 |
| 課金 | Stripe契約とEntitlementを接続 | 紹介特典から契約を作らない |
| 監査 | ADMIN+AAL2、理由、`AuditLog`、一部revision制御 | 再利用・設定版追加 |

## 4. 現行DBの制約と不足

### 4.1 紹介特典

`ReferralMilestone.requiredReferralCount`は一意であり、同じ5人達成時に「一日券」と「限定動画」を同時に設定できない。`rewardType`とDB制約は`DAY_PASS`だけを許可する。

`ReferralReward`は一つの`dayPassId`だけを保持するため、次を表現できない。

- 一日券2枚を別々の日に使用する
- 7日・14日・30日の期間限定閲覧権限
- 複数のCMSコンテンツへの限定アクセス
- 獲得時の名称、説明、条件、日数、対象コンテンツの固定
- 設定変更後も変更前の権利内容を再現する

また、現行付与処理は成立人数以下の有効milestoneを再評価する。新たな5人特典を有効化しただけでは、既に5人以上達成した既存会員へ次回処理時に遡及付与される危険がある。

### 4.2 Entitlementと会員区分

`FOUNDER`と`STANDARD`は月額行、`DAY_PASS`は1日利用行、`MANUAL`は手動付与行として`ContentAccessPolicy`へ対応する。紹介特典の月額相当権限を`STANDARD`や`MANUAL`として偽装すると、課金契約や手動付与との由来を区別できない。

紹介用のplan codeを追加し、Stripe `Subscription`を作らず期間付き`Entitlement`だけを発行する案が安全である。閲覧ポリシーも`referralMonthly`行として月額行と別管理し、初期値だけ月額と同等にする。

### 4.3 LIMITED_CONTENT

CMSは権限がない場合に本文・動画URLを返さないため、既存のサーバー側境界を利用できる。ただし現在のvisibilityは`PUBLIC`、`MEMBERS`、`PAID`であり、「特定の紹介特典を持つ会員だけ」を表現しない。

特典版と`ContentItem`の対応表、および有効な獲得権利を確認する追加経路が必要である。公開終了・アーカイブ・特典権利失効のいずれか一つでも成立しない場合は本文・media URLを返さない。

### 4.4 1日券の開始条件

現在は対象日にWIN5商品が存在すると、初版公開まで`DayPass`が`PENDING`のままでEntitlementが作成されない。WIN5が公開されない場合、対象日になって公開済みパドックが存在しても閲覧できない。

目標ルールは次とする。

1. 対象日前にWIN5初版が公開された場合は、その公開時刻から利用開始する。
2. WIN5未公開でも対象日0:00 JSTになれば利用開始する。
3. 対象日当日に購入・利用した場合は、成立時刻から利用開始する。
4. 終了は対象日の翌日0:00 JST（排他的）とする。
5. 購入一日券と紹介一日券へ同じルールを適用し、同じ会員・対象日の重複を拒否する。

これにより「WIN5未公開のまま終了した購入一日券」を未開始として扱う現行返金確認条件は変わる。返金対象をサービス障害・公開不履行へ再定義するかは、実装前の事業判断を要する。

### 4.5 無料登録特典

現在は`role=MEMBER`かつ`registrationMethod=LINE`だけが対象で、メール登録後にLINE連携した会員も対象外である。視聴履歴は会員・特典ごとに保持されている。

将来は次のどちらかを満たす本人確認済み無料会員へ同じ通常登録特典を提供し、既存視聴履歴とAPI互換性を維持する。

- LINE登録が完了している
- メール登録で`emailVerifiedAt`が設定されている

紹介達成限定コンテンツの権利とは統合しない。

## 5. 再利用する既存資産

- `Referral`の紹介関係、成立・無効化、自己紹介拒否
- 紹介成立時のトランザクションとreferrer単位ロック
- `DayPass`、`Entitlement`、対象日一意制約、既存閲覧判定
- `ContentItem`、追記型`ContentVersion`、公開状態
- CMS本文・media URLを権限判定後だけ返すAPI
- `ContentAccessPolicy`、無料全文テストとの分離
- ADMIN+AAL2、CSRF、revision、Idempotency-Key、`AuditLog`の既存方式
- 課金契約を正本とする`Subscription`（参照のみ。紹介特典で変更しない）
- 既存紹介管理・会員紹介画面のルートとナビゲーション
- 紹介、WIN5、CMS、課金、権限に関する既存integration/E2Eテスト

## 6. 追加が必要な能力

- 同じ達成人数へ複数設定できる特典定義
- 特典定義の追記型バージョンと有効期間
- `DAY_PASS`、`MONTHLY_ACCESS`、`LIMITED_CONTENT`の共通付与境界
- 達成時点・適用版・権利内容の不変スナップショット
- 数量分を個別に利用できる特典単位
- 明示受取、利用、失効、無効化の状態遷移
- 月額契約と独立した期間限定Entitlement
- CMSコンテンツ単位の紹介特典アクセス
- 管理設定の同時編集検出、理由、変更前後の監査
- 期間指定KPIとコンバージョン定義
- 対象日0:00 JSTでPENDING一日券を有効化する安全なworker処理

## 7. 既存会員・既存特典の保護

1. 現在の3人・10人milestone、付与済み`ReferralReward`、利用済み`DayPass`を更新・削除しない。
2. 新モデルへ切り替える場合も、既存rewardから現在の内容を再現できるlegacy adapterまたは対応版を用意する。
3. 初期候補の3・5・10特典をmigrationだけで有効化しない。管理画面で将来時刻を明示して有効化する。
4. 紹介成立ごとに「直前人数、成立後人数、成立日時」を固定し、その時点で有効な版だけを評価する。
5. 新しい5人特典を、既に5人以上達成済みの会員へ通常変更として付与しない。
6. 使用済み、期限切れ、無効化済みを含む履歴を物理削除しない。
7. 既存Stripe契約の期間、更新、解約、価格を紹介特典から変更しない。

## 8. 権限・セキュリティ監査

- 特典設定は会員・権限・課金に影響するため`ADMIN+AAL2`に限定する。`OPERATOR`へ付与しない。
- role、会員ID、達成人数、権利状態をクライアント値から信用しない。
- 特典版の公開・停止はrevisionと確認済みversionを照合する。
- 利用APIはIdempotency-Keyを必須とし、同じ要求は同じ結果を再生する。
- DAY_PASSは既存の会員・対象日一意制約に加え、特典単位の利用一意制約を置く。
- MONTHLY_ACCESSは特典単位で一つのEntitlementだけを発行する。
- LIMITED_CONTENTは一覧・詳細・media URL返却の全経路でサーバー判定する。
- 特典定義版、獲得権利、利用記録、監査ログは公開・使用後に上書きしない。
- 期限はUTCで保存し、表示と開催日境界だけJSTで計算する。

## 9. 管理画面と会員画面の差分

### 管理画面

現状の`/admin/referrals`へ、設定、特典一覧、版履歴、獲得・利用・失効、期間KPIのタブを追加する。設定フォームは名称、説明、必要人数、種別、数量、有効期限、配布期間、公開、新規付与、表示順、案内文、利用条件、変更理由を扱う。

CMS選択はID手入力ではなく既存コンテンツを検索して選ぶ。設定停止と既得特典取消を別操作にし、通常画面には既得特典一括取消を設けない。

### 会員画面

既存URLを維持し、紹介URL、紹介コード、成立人数、次の目標、達成・未使用・使用済み・期限切れを種別別カードで表示する。固定の「一日券」文言と3・10の数値を廃止し、公開中の設定と本人の獲得スナップショットを使用する。

## 10. KPI監査

現状は紹介成立、紹介者数、milestone別付与・利用を現在値で表示するが、期間指定、失効、利用率、有料化の帰属を持たない。

追加候補は次のとおり。

- 紹介URL経由登録: `Referral.createdAt`
- 成立紹介: `qualifiedAt`
- 条件到達: 達成イベント時刻
- 付与・利用・失効: 各権利イベント時刻
- 特典利用率: 利用数 / 付与数。対象期間の分母定義を画面に表示
- 有料申込: Stripe成功後に成立したsubscriptionだけを集計
- 月額体験後有料化: referral monthly終了後の初回有料subscription

有料化の帰属対象（紹介者か被紹介者か）と帰属期間は事業判断が必要である。

## 11. テスト影響

既存テストを維持し、Phase B以降で次を追加する。

- 同一人数の複数特典と累積付与
- 版変更前後の獲得内容固定、過去への非遡及
- 停止後の新規付与停止と既得権維持
- 数量2以上の個別利用、並行利用、Idempotency-Key再送
- MONTHLY_ACCESSの期限切れ、既存subscription不変
- LIMITED_CONTENTの本文・media URL拒否
- WIN5未公開の対象日0:00有効化
- LINE・確認済みメール登録者の共通特典
- 無料会員の有料本文拒否
- ADMIN+AAL2、CSRF、revision競合
- desktop/mobileの設定・紹介進捗・利用導線

## 12. 事業判断が必要な事項

| ID | 判断事項 | 推奨案 |
| --- | --- | --- |
| BD-01 | 有料契約中にMONTHLY_ACCESSを受け取った場合 | 契約を変更せず、重複期間を明示して会員が開始。開始延期を許すなら保有期限も別途定義する |
| BD-02 | MONTHLY_ACCESSの開始時点 | 自動付与時ではなく会員の明示受取時。受取後N日、終了は排他的時刻 |
| BD-03 | 特典自体の受取期限と、利用開始後の権利期限 | 別項目で管理する。未指定を無期限にするか上限を設けるか確定が必要 |
| BD-04 | 5人の限定解説動画 | 対象`ContentItem`と公開終了時の案内を運営が選択する |
| BD-05 | 1日券の開始変更後の返金条件 | 「WIN5未公開」だけでなく、実際に提供不能だったかをADMINが確認する別基準へ変更 |
| BD-06 | 有料化KPIの帰属対象と期間 | 紹介特典を獲得した紹介者を対象に、利用または体験終了から30日以内を初期候補とするが承認が必要 |
| BD-07 | 既存3人・10人施策から新3・5・10施策への切替日時 | migrationでは有効化せず、管理画面で将来時刻を指定し二名確認する |
| BD-08 | LIMITED_CONTENTの権利失効後の視聴履歴表示 | 履歴名は残し、本文・media URLは返さない |

## 13. 技術的リスク

| 優先度 | リスク | 対策 |
| --- | --- | --- |
| BLOCKER | 新設定が既存達成者へ遡及付与される | 達成イベントと有効版を固定し、移行時の基準人数を保存 |
| HIGH | reward数量と複数リソースの不整合 | 利用可能単位を別行にし、一意制約とトランザクションを使用 |
| HIGH | 月額特典がStripe契約を変更する | 専用plan codeのEntitlementのみ発行しSubscriptionへ書き込まない |
| HIGH | CMS URL漏えい | 全APIで権限判定。外部配信URLの再共有耐性は別途署名URL/DRM課題として明記 |
| HIGH | 1日券開始変更と返金運用の不一致 | Phase C前に返金基準を承認し、回帰テストを追加 |
| MEDIUM | KPIの数字が定義により変わる | 分母、期間、帰属を画面と文書へ表示 |
| MEDIUM | 設定変更の競合 | revision、理由、AAL2、監査、DB一意制約 |

## 14. 変更候補ファイル

- `packages/db/prisma/schema.prisma`とadditive migration
- `packages/domain/src/referrals.ts`
- `packages/domain/src/content-access.ts`
- `apps/api/src/referrals.controller.ts`
- `apps/api/src/referrals.service.ts`
- `apps/api/src/day-pass-access.ts`
- `apps/api/src/content.controller.ts`
- `apps/api/src/free-reports.controller.ts`と関連service
- `apps/web/components/admin-referrals.tsx`
- `apps/web/components/referrals.tsx`
- `apps/web/components/free-reports.tsx`
- `tests/referrals.integration.test.ts`
- `tests/content.integration.test.ts`
- `tests/win5.integration.test.ts`
- `tests/free-member-line.integration.test.ts`
- `tests/e2e/referrals.spec.ts`と関連E2E

## 15. 今回変更しないもの

- 本番DBと本番環境
- Stripe商品、Price、契約、自動課金、自動更新
- 実会員の紹介人数、特典、DayPass、Entitlement
- 実会員への通知
- 公開済み予想、CMS公開版、監査履歴
- AIレースガイドの予測機能
