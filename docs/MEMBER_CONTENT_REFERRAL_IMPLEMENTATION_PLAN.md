# 会員別コンテンツ配信・紹介特典管理 実装計画

## 1. 方針

実装はPhase B、C、Dを独立したレビュー可能なPRに分ける。各PhaseでDB、domain、API、UI、テストを縦に完結させ、次Phaseへ自動的に進まない。

この文書はPhase Aの設計であり、モデル名とAPIは実装開始時に既存命名規約へ合わせて最終決定する。

## 2. 目標アーキテクチャ

```text
Referral QUALIFIED
  -> ReferralAchievement（成立時点の人数を追記）
  -> 有効なReferralBenefitVersionを選択
  -> ReferralRewardGrant（獲得内容を固定）
       -> DAY_PASS: 会員が対象日を選択 -> DayPass + Entitlement
       -> MONTHLY_ACCESS: 会員が開始 -> Entitlementのみ
       -> LIMITED_CONTENT: 対象ContentItemをサーバー側許可
```

設定と獲得権利を分離する。設定変更は新しい版を追加し、既得権を更新しない。

## 3. DB変更案（すべてadditive）

### 3.1 `ReferralBenefit`

特典の安定した識別子を持つ。物理削除せず、表示や新規付与の停止は版で表現する。

候補項目:

- `id`
- `createdAt`
- `createdBy`

### 3.2 `ReferralBenefitVersion`

設定変更ごとの追記型スナップショット。

- `benefitId`
- `version`
- `revision`
- `name`
- `description`
- `requiredReferralCount`
- `rewardType`: `DAY_PASS | MONTHLY_ACCESS | LIMITED_CONTENT`
- `quantity`
- `claimValidityDays`または`claimExpiresAt`
- `accessDays`（MONTHLY_ACCESSのみ）
- `distributionStartsAt` / `distributionEndsAt`
- `published`
- `grantEnabled`
- `sortOrder`
- `memberGuidance`
- `usageTerms`
- `changeReason`
- `createdBy` / `createdAt`

`requiredReferralCount`は一意にしない。`(benefitId, version)`だけを一意にする。種別別の必須・禁止項目はdomainとDB制約の両方で検証する。

### 3.3 `ReferralBenefitVersionContent`

LIMITED_CONTENT版と複数の`ContentItem`を結ぶ。公開版を直接複製せず、CMSの公開状態と最新公開versionを利用する。

### 3.4 `ReferralAchievement`

紹介成立により人数が増えた事実を追記する。

- `referrerId`
- `referralId`
- `previousQualifiedCount`
- `qualifiedCount`
- `achievedAt`

`referralId`を一意にして再送を防ぐ。移行時は既存会員の現在人数をbaselineとして記録し、過去の個別達成を捏造しない。

### 3.5 `ReferralRewardGrant`

会員が獲得した権利の正本。版の内容をスナップショットとして固定する。

- `userId`
- `benefitVersionId`
- `achievementId`
- `unitNo`
- `rewardType`
- `snapshot`
- `status`: `AVAILABLE | USED | EXPIRED | INVALIDATED`
- `grantedAt` / `claimExpiresAt` / `usedAt` / `invalidatedAt`
- `dayPassId`または`entitlementId`（種別に応じて一つ）

数量は`unitNo`ごとの行に分け、`(userId, benefitVersionId, achievementId, unitNo)`を一意にする。同じ版を複数達成で繰り返し付与する仕様は初期対象外とし、必要時はcampaign cycleを追加する。

### 3.6 ContentAccessPolicy

`referralMonthly`行を後方互換に追加し、既存monthlyと同じ初期値を入れる。`REFERRAL_MONTHLY_ACCESS`のEntitlementだけがこの行を使用する。無料全文テストと`MANUAL`は変更しない。

## 4. 状態遷移

### 設定

```text
DRAFT -> PUBLISHED
PUBLISHED -> 新しいPUBLISHED版
PUBLISHED -> grantEnabled=falseの新しい版
```

既存版をUPDATEして意味を変えない。誤りは訂正版を追加する。

### 獲得権利

```text
AVAILABLE -> USED
AVAILABLE -> EXPIRED
AVAILABLE -> INVALIDATED（不正紹介の管理確認時のみ）
```

`USED`から戻さない。設定停止は既存の`AVAILABLE`を失効させない。

## 5. Phase B: 紹介特典設定・付与基盤

### 実装

- additive migrationとlegacyデータ互換
- 特典設定・版・達成・権利単位のdomain contract
- ADMIN+AAL2限定の設定一覧、作成、改版、公開、付与停止API
- DAY_PASS、MONTHLY_ACCESS、LIMITED_CONTENTのgrant adapter
- Idempotency-Key、revision、監査ログ
- 管理画面の設定・版履歴・権利状況
- 初期3・5・10候補は非有効状態で用意するか、管理画面から作成する

### 管理API候補

- `GET /admin/referrals/benefits`
- `POST /admin/referrals/benefits`
- `POST /admin/referrals/benefits/:id/versions`
- `POST /admin/referrals/benefits/:id/publish`
- `POST /admin/referrals/benefits/:id/grants/stop`
- `GET /admin/referrals/rewards`

### 完了条件

- 既存3人・10人rewardの意味と利用を維持
- 新しい5人特典を既存達成者へ遡及付与しない
- 同一人数へ複数特典を設定可能
- 3種の付与処理が共通interface経由
- Stripe通信なし、既存subscription変更なし
- unit、DB、integration、管理E2E PASS

## 6. Phase C: 会員画面・コンテンツ権限

### 紹介画面

- 紹介コードを明示
- 次の目標を設定から算出
- 達成、未使用、使用済み、期限切れを分離
- DAY_PASSは対象日選択
- MONTHLY_ACCESSは期間と既存契約への非影響を確認して開始
- LIMITED_CONTENTは権利のあるCMS詳細へ遷移

### コンテンツ権限

- `REFERRAL_MONTHLY_ACCESS`を`referralMonthly`ポリシーへ対応
- LIMITED_CONTENTは対象`ContentItem`、権利期間、公開状態を毎回確認
- API拒否時に本文・media URLを含めない
- FOUNDERとSTANDARDの既存monthly判定を維持

### 1日券

- WIN5初版公開時と対象日0:00 JSTの早い方で有効化
- 対象日当日の成立は即時有効化
- 終了は翌日0:00 JST
- workerを冪等化し、購入・紹介の両方を処理
- 返金確認一覧と案内文を承認済み基準へ更新

### 通常登録特典

- LINE登録済みまたはメール確認済みの一般会員を対象にする
- 既存`FreeMemberBenefitView`を維持
- 紹介LIMITED_CONTENTとはAPI・権利を分離
- 旧URL/APIは互換経路を残す

### 完了条件

- 無料会員へ有料本文を返さない
- 直接URLでも限定CMSを拒否
- WIN5未公開でも対象日のパドックを閲覧可能
- 登録経路によらず本人確認済み会員が通常登録特典を閲覧可能
- desktop/mobile E2E PASS

## 7. Phase D: 集計・総合検証

### KPI

- JST期間指定をUTCの半開区間へ変換
- URL経由登録、成立、条件到達、付与、利用、利用率、失効
- 有料化と月額体験後有料化（承認済み帰属ルールのみ）
- 集計には表示名、メール、LINE識別子を不要に含めない

### 総合テスト

- 3・5・10累積付与
- 設定変更前後、停止、期限切れ
- 同時成立、同時利用、API再送
- 既存有料契約中の利用
- CMS URL不正アクセス
- 1日券とWIN5未公開
- 無料本文拒否
- LINE・メール共通登録特典
- 管理・会員画面のPC/スマートフォン
- WIN5、パドック、通常紙面、CMS、課金、LINE、通知の回帰

### 運用文書

- 特典作成・改版・停止
- campaign切替
- 不正紹介無効化
- 期限切れと問い合わせ対応
- KPI定義
- rollback（新規付与停止。既得権を削除しない）

## 8. 移行順序

1. additive migrationを適用する。
2. 旧読取・利用経路を維持したまま新設定APIを配備する。
3. 既存3人・10人をlegacyとして参照できることを検証する。
4. 新3・5・10候補を非公開・付与停止で確認する。
5. 承認した将来日時をcutoverとし、新しい達成だけへ適用する。
6. 旧milestoneへの新規付与を停止するが、旧rewardの利用は継続する。
7. 監視期間後も旧行を削除しない。

本番migration、cutover、通知、課金有効化は各実装PRとは別承認とする。

## 9. Rollback

- 設定または権利判定に問題があれば、新しい特典版の`grantEnabled`を停止する。
- API feature flagで新しい設定・利用UIを非表示にする。
- 既に付与した権利を一括削除しない。
- 旧3人・10人reward利用経路へ戻せる期間を設ける。
- additive tableは緊急時にもDROPしない。

## 10. 承認ゲート

Phase B開始条件:

- `BD-01`から`BD-08`の回答
- 初期3・5・10の文言、期限、対象限定動画
- 既存施策のcutover日時
- 月額体験の開始・重複条件
- 1日券の返金基準
- KPI帰属定義
