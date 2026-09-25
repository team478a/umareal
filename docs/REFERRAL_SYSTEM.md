# 友達紹介制度 V1

## 制度概要

ログイン可能な一般会員は、個人情報を含まない一意の紹介コードと `/register?invite=...` の紹介URLを持つ。紹介された人が通常の無料会員登録と本人確認を完了すると紹介が成立する。初期マイルストーンはDBで管理し、3人と10人の成立時にそれぞれ一日券を1枚付与する。

既存の `MemberAcquisition.referralCode` と `AcquisitionCampaign.referralCode` は広告・流入計測として意味を変更しない。会員間の紹介コードは `users.referralCode`、関係は `referrals` に分離する。URLでも流入計測用 `ref` と会員紹介用 `invite` を分ける。

## DB構造

- `users.referralCode`: 既存・新規会員に付く20文字のランダムなURL安全コード。DB既定値、一意索引、NOT NULLを持ち、変更機能を設けない。
- `referrals`: 紹介者、被紹介者、`PENDING / QUALIFIED / INVALIDATED`、成立時刻、無効化理由・管理者を保持する。`referredUserId` は一意で、自己紹介もCHECK制約で拒否する。
- `referral_milestones`: 必要成立人数、特典種別、数量、有効日数、有効状態、表示順を保持する。初期値は `3 / DAY_PASS / 1 / 60日` と `10 / DAY_PASS / 1 / 60日`。
- `referral_rewards`: 会員とマイルストーンの組を一意にし、`AVAILABLE / REDEEMED / EXPIRED / INVALIDATED`、付与・期限・利用時刻、一日利用IDを保持する。
- `day_passes.source`: 購入由来は `PURCHASE`、紹介特典は `REFERRAL_REWARD` として区別する。既存行は `PURCHASE` へ安全に補完する。
- LINE OAuthと登録grantは `memberReferralCode` を短時間だけサーバー内で引き継ぐ。

マイグレーションは既存 `MemberAcquisition` を変更・削除せず、既存会員へコードをバックフィルしてからNOT NULLと一意索引を設定する。本番データの物理削除は行わない。

## 紹介成立条件

紹介URLの表示だけでは成立しない。登録時に有効な紹介コードを解決して `PENDING` を作り、メール確認またはLINE登録の本人確認が完了したトランザクションで `QUALIFIED` にする。存在しないコードや長さ上限内の改ざん済みコードは、コードの有効性を画面へ表示せず通常登録として扱い、紹介関係を作らない。公開APIを無制限入力から守るため、256文字を超える紹介コンテキストは入力自体を拒否する。

メール登録はフォーム再描画中もURLの `invite` を保持し、登録時にサーバーDBへ `PENDING` を保存する。ローカル確認URL、Supabase確認コールバック、確認済みセッションのいずれでも同じ冪等な成立処理を通るため、確認画面へ紹介コードを露出・再送する必要はない。LINE登録は開始時に `invite` をOAuth flowへ保存し、callback後の使い切り登録grantへ引き継ぎ、会員・LINEアカウント・紹介成立を同じトランザクションで作る。LOGINとLINK用途には紹介コードを受け付けず、通常登録にはReferralを作らない。

成立後の紹介者変更APIは設けない。被紹介者一意制約により複数紹介者への計上をDBでも拒否する。既存メール、既存LINE subject、解除済みLINE tombstone、退会記録に関する既存の再登録防止を利用する。通常退会では過去の成立実績を自動減算しない。

## マイルストーンとReward

成立処理は紹介者単位のPostgreSQL transaction advisory lockを取得し、成立人数を再集計する。有効なマイルストーンをDBから読み、`userId + milestoneId` の一意制約を使って1回だけ特典を付与する。3人目と4人目、10人目と11人目が同時に確認を完了しても同じロックと一意制約を通る。人数、期限、数量を画面や成立ロジックへ直接埋め込まない。

紹介特典は獲得時点で閲覧権限を開始しない。会員が未使用Rewardの対象日を選び、交換時に既存の `createDayPassAccess` を通して `DayPass` と `Entitlement(planCode=DAY_PASS)` を作る。WIN5初版公開済みなら公開時刻から対象日終了まで、未公開なら既存仕様どおりPENDINGで待機し、初版公開時に有効化する。対象日終了はJST翌日0時の排他的終端である。

交換はReward単位のDBロック、Reward状態、期限、本人所有、同一対象日の既存DayPassを再検証する。選択できる対象日は本日からReward有効期限のJST日付までとする。使用済み・期限切れ・無効Rewardは再利用できない。一日利用アクセス判定は既存 `Entitlement` だけを使い、紹介専用の権限判定を作らない。

## 不正対策

- コードはUUID由来80bitのランダム値で、メール、User ID、LINE subjectを含めない。
- 自己紹介はアプリ確認とDB CHECK、被紹介者重複は一意制約で拒否する。
- 既存メール、既存LINEアカウント、退会後の再登録は既存認証・tombstoneを使って拒否する。
- IPアドレスは保存せず、自動失格条件にも使わない。
- 同時成立は紹介者単位ロック、状態付き更新、マイルストーン一意制約で二重計上・二重付与を防ぐ。
- URLに個人情報、token、秘密値を含めず、AuditLogにもメール、LINE subject、認証情報を記録しない。

## 管理者操作

`/admin/referrals` はADMIN+AAL2だけが利用できる。成立数、紹介者数、DBにある各マイルストーンの達成人数、特典付与・使用数、紹介者別集計、最近の紹介記録を表示する。詳細は表示名、登録方式、登録・成立時刻、状態を基本とし、メールアドレスを表示しない。

成立済みReferralは理由必須で無効化できる。無効化後の成立人数がマイルストーンを下回った場合、有効期限内で未使用の `AVAILABLE` Rewardだけを `INVALIDATED` にする。無効化処理時点ですでに期限を過ぎた `AVAILABLE` は先に `EXPIRED` へ確定する。使用済みDayPassとEntitlementは巻き戻さない。後日正当な成立で再び同じマイルストーンへ到達した場合、元の交換期限内にある未使用の `INVALIDATED` Rewardだけを同じ行・元の付与日時・元の有効期限のまま再有効化する。`REDEEMED`、`EXPIRED`、または無効化中に元の期限を過ぎたRewardは復活させず、別行も作らない。

紹介成立、マイルストーン達成、特典付与、特典利用、管理者無効化は既存AuditLogへ対象種別 `REFERRAL / REFERRAL_MILESTONE / REFERRAL_REWARD` を付けて追記する。無効化APIの再送は同じ結果を返し、二重操作しない。メール、LINE subject、token、紹介URLは監査詳細へ保存しない。

## API

| Method | Path | 権限・動作 |
| --- | --- | --- |
| GET | `/me/referrals` | MEMBER本人。コード、URL、成立人数、次の特典、マイルストーン、Reward一覧 |
| GET | `/me/referral-rewards` | MEMBER本人。Reward一覧 |
| POST | `/me/referral-rewards/:id/redeem` | MEMBER本人。`{targetDate}` で既存一日利用へ交換 |
| GET | `/admin/referrals` | ADMIN+AAL2。`page`、`status`による集計・紹介者・最近の記録 |
| GET | `/admin/referrals/:id` | ADMIN+AAL2。紹介詳細 |
| POST | `/admin/referrals/:id/invalidate` | ADMIN+AAL2。`{reason}` 必須で成立紹介を無効化 |

登録APIは任意の `memberReferralCode` を受け付ける。マーケティング流入の `acquisition.referralCode` とは別項目である。

## 画面

マイページの「友達紹介」に、成立人数、次の特典までの残数、DBマイルストーン、紹介URL、LINE共有、コピー、未使用・使用済み・期限切れ特典、対象日選択を表示する。LINE共有は会員本人の操作で共有画面を開くだけで、Messaging APIによる代理送信や自動投稿は行わない。

紹介URLを開いた人には通常の無料登録画面を表示し、既存の成人・規約・プライバシー同意、メール確認またはLINE登録、登録特典動画、無料コンテンツ導線を維持する。

## テスト

`tests/referrals.integration.test.ts` はメール確認前後、流入計測との分離、通常・無効・改ざんコード登録、3/4/10/11人、3人目/4人目と10人目/11人目の同時成立、LINE登録、Reward交換、過去日・期限後・同一日・再利用の拒否、自己・重複、ADMIN+AAL2、3人/10人での無効化と再到達、`INVALIDATED` の再有効化、`REDEEMED / EXPIRED` の非復活、監査を検証する。

`tests/e2e/referrals.spec.ts` はPCとiPhone相当幅で、紹介者ログイン、マイページの紹介URL、LINE共有URL、新規会員のフォーム登録、メール確認、成立人数反映、特典表示、横スクロールなし、管理画面の集計・詳細・理由付き無効化を実ブラウザで検証する。`tests/win5.integration.test.ts` は購入一日券と紹介一日券の両方が公開待ち `PENDING` になり、WIN5初版公開で同じ既存処理から `ACTIVE` とEntitlementへ移行し、同じWIN5本文を閲覧できることを検証する。Supabase認証試験は `PENDING` からcallback後の `QUALIFIED` までを検証する。既存acquisition、billing、Stripe、月額アクセスの試験も削除・skipせず実行する。

## 将来拡張とV1対象外

マイルストーン行の追加・停止で5人、20人、50人等へ拡張できる。Rewardは紹介関係から分離しているが、V1では紹介特典以外の汎用キャンペーンエンジン、現金、割引、ポイント、ランキング、多段階紹介、アフィリエイト、代理店報酬、SNS自動投稿を実装しない。マイルストーン編集UI、手動Reward付与、使用済み権限の取消もV1対象外とする。
