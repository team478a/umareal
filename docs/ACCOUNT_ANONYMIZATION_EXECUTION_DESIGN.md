# 退会後個人情報の匿名化実行設計

作成日: 2026-10-06

状態: 設計のみ。実行機能、DB migration、本番操作は未承認・未実装。

## 1. 目的と境界

退会時の利用停止と追記専用記録は実装済みである。本書は、正式な保持方針に従って保持期限へ到達した個人情報を将来匿名化する場合の、安全な承認、実行、検証、証跡の境界を定める。

本書だけを根拠に匿名化を実行してはならない。実装開始には、対象field、保持期間、法定保存、本人請求、再登録、外部事業者での削除・保持について法務・運用の承認が必要である。

今回行わないこと:

- 個人情報の更新、匿名化、削除
- Supabase Auth、LINE、Stripe、Resend等の外部操作
- 匿名化API、worker、CLI、DB trigger、migrationの実装
- `development-v1`への正式方針の遡及適用
- 公開、評価、課金、同意、監査履歴の削除
- 本番deploy、本番migration

## 2. 不変条件

1. 対象は`AccountClosure.retentionPolicyVersion`に固定された同一versionの承認済み保持方針だけで判定する。
2. `POLICY_UNMAPPED`、保持期限前、法的保全中、本人確認未完了、未解決の課金・問い合わせがある対象は実行しない。
3. 申請者と承認者を別の有効な`ADMIN+AAL2`とする。一人で申請から完了まで進められない。
4. 候補snapshot、方針、対象field、外部作業、実行プログラムの版のいずれかが変わったら承認を失効させ、再申請する。
5. 一括全件実行から開始しない。初期実装は退会記録1件単位、明示的な実行確認、上限1件とする。
6. 公開版、評価、結果、契約、支払、返金、同意、問い合わせ、監査の業務履歴と参照整合性を維持する。
7. 秘密値、元の識別子、外部provider応答本文を監査詳細や検証レポートへ複製しない。
8. 匿名化後の元値を復元できる対応表、暗号化退避、ログ、バックアップを新しく作らない。
9. 失敗を成功扱いにしない。部分成功は`PARTIAL_FAILURE`として停止し、人が確認する。
10. Readinessは、設計やdry-runだけで`READY`へ変更しない。

## 3. 役割分離

| 役割 | 許可 | 禁止 |
| --- | --- | --- |
| 申請者 | 候補snapshot確認、対象1件の実行申請、理由と法務参照の記録 | 自分の申請承認、実行結果の単独完了 |
| 承認者 | snapshot、方針version、対象field、除外理由、外部作業の独立確認 | 自分が作った申請の承認 |
| 実行者 | 承認済みplanと完全一致する処理だけを実行 | 対象追加、field追加、方針変更、承認なしの再試行 |
| 検証者 | DBと外部作業の完了証跡を確認し、完了または要対応を記録 | 元値をレポートへ保存 |

初期運用では申請者、承認者、検証者のうち少なくとも2名の別管理者を必要とする。自動スケジュール実行は、実運用件数と失敗パターンを確認した別フェーズまで禁止する。

## 4. 状態モデル案

```text
DRAFT
  -> REQUESTED
  -> APPROVED
  -> EXECUTING
  -> DB_VERIFICATION_REQUIRED
  -> EXTERNAL_VERIFICATION_REQUIRED
  -> COMPLETED

REQUESTED / APPROVED
  -> EXPIRED
  -> REJECTED
  -> STALE

EXECUTING / verification
  -> PARTIAL_FAILURE
```

- `DRAFT`: 現在データから決定的に作った候補。変更操作なし。
- `REQUESTED`: 申請者が対象、理由、法務参照、snapshot hashを固定。
- `APPROVED`: 別管理者が同じsnapshotを承認。承認有効時間は実装時に設定化し、無期限にしない。
- `STALE`: 方針version、対象データ、除外条件、実行logic versionの変更を検知。
- `PARTIAL_FAILURE`: DBまたは外部事業者の一部だけ完了。自動ロールバックや別対象への続行をしない。
- `COMPLETED`: DB検証と、必要な全外部確認が完了し、検証者が証跡を固定。

状態履歴は追記専用とし、過去状態を更新・削除しない。現在状態はイベント列から再現できるようにする。

## 5. 実行前Gate

すべて満たさない限り`APPROVED`へ進めない。

- 対象会員が`disabledAt`設定済みで、`AccountClosure`が存在する
- 退会時に作成したsession、通知、LINE、権限失効処理が完了している
- 退会記録の保持方針versionと承認済み方針versionが完全一致する
- `eligibleAt <= now`である
- 匿名化対象fieldが正式方針のallowlist内だけである
- 保持すべき業務履歴と外部参照を一覧化できる
- 未完了Checkout、返金、課金問い合わせ、一般問い合わせ、本人開示・削除請求、法的保全の有無を確認できる
- 対象がスタッフ、公開者、確認者等の運用主体である場合、履歴上の表示方針が承認済みである
- Supabase Auth、LINE等の外部操作が必要な場合、provider別手順と確認責任者が決まっている
- 対象DB backupの保持期間・削除時期が正式方針と整合する

現行DBには法的保全、本人請求、匿名化planの状態を構造化保存する専用modelがない。そのため、これらが必要な実行実装はadditive migrationを別途設計する。監査ログだけを実行キューとして流用しない。

## 6. 現行データの分類

以下は現行schemaの調査結果であり、実際の処理対象は正式方針で決める。

### 6.1 識別情報候補

- `users.email`、`displayName`、`authSubject`
- `users.passwordHash`、MFA関連field、認証・再設定・確認token
- `line_accounts.subject`
- `email_verifications.email`
- `member_acquisitions`の流入詳細と紹介コード
- LINE OAuth / registration grantの暗号化subject、hash、流入情報
- 監査ログ等に保存されたIP・User-Agentまたは識別可能な運用理由

秘密情報と一時認証情報は「匿名化用に保存」せず、既存の失効・期限切れ処理と正式な削除方針を使う。元値のhashを長期保持すると照合可能性が残るため、hash化を匿名化とみなさない。

### 6.2 保持候補

- `account_closures`と保持方針version
- 公開済み予想・紙面・AIガイド、評価、結果の版と公開者参照
- 契約、支払、返金、請求event
- 同意履歴
- 問い合わせと対応event
- 紹介成立・特典利用の会計・不正防止上必要な履歴
- 監査ログと匿名化承認・実行・検証証跡

保持履歴の`userId`は内部UUIDとして維持する案を優先する。外部へ表示する管理画面では、匿名化完了後に元の氏名・メールを出さず「匿名化済み会員」と内部参照コードだけを表示する。

### 6.3 外部事業者

- Supabase Auth: Auth user、session、factor、identityの扱いをprovider仕様と法務方針に従って確認
- LINE: Login subject、Messagingの友だち・配信状態、provider側保持の削除可能範囲を確認
- Stripe: 法定・会計・不正防止上の保持とCustomerの削除・redaction可否を確認し、アプリ判断で削除しない
- Resend: delivery/webhook retention、宛先情報の保持と削除依頼手順を確認

外部操作はDB transactionへ含められない。DB処理と外部処理を別stepとして記録し、再試行は同じplanと冪等キーに固定する。

## 7. 匿名化方法の原則

- メール等の一意制約を満たす置換値が必要な場合は、元値から導出しないランダムな内部surrogateを使用する。実装時に予約domain、長さ、一意性を検証する。
- 表示名は識別情報を含まない固定表現と内部参照コードへ置換する。元の文字数や一部を残さない。
- 外部subject、password hash、MFA秘密、未使用tokenは、保持根拠がなければnull化または安全な削除候補とする。具体的なfield操作はschema制約と外部認証運用を検証して決める。
- 流入情報、IP、User-Agent、自由記述は準識別子として扱い、fieldごとに削除、粗粒度化、保持を明示する。
- 公開者・確認者として必要な履歴参照は内部UUIDを維持し、本人表示だけを匿名化する。
- `referralCode`等が再利用可能な導線になる場合は無効化を検討するが、紹介成立・特典履歴を壊さない。

## 8. 実行アルゴリズム案

1. `AccountClosure`行をロックし、planの対象を1件へ固定する。
2. 申請時snapshot hash、保持方針version、期限、legal hold、未解決業務、現在の識別field指紋を再計算する。
3. 承認時と差分があれば書き込み前に`STALE`で停止する。
4. DB内の対象fieldだけを1 transactionで匿名化し、実行eventを追記する。
5. transaction後に、元値を返さない決定的verificationを実行する。
6. 外部事業者ごとに冪等な操作または人手確認を行い、結果コードと時刻だけを追記する。
7. 全必須verificationが成功した場合だけ、別管理者が`COMPLETED`を記録する。

外部操作の途中で失敗してもDBを元値へ戻すための復元コピーは作らない。`PARTIAL_FAILURE`として対象を隔離し、成功済みstepを再実行せず未完了stepだけを同じplanから再開する。

## 9. 検証と復旧不能性

復旧不能性は「画面から見えない」ではなく、次を証拠に判定する。

- DB queryで対象allowlist fieldに元値が存在しない
- unique index、FK、追記専用trigger、主要履歴件数が維持される
- API、管理画面、CSV、通知、検索から元の氏名・メール・subjectを取得できない
- session、reset、verification、OAuth等の資格情報で認証できない
- Supabase Auth、LINE等の必須外部stepがprovider側で完了または保持根拠付き除外として記録される
- アプリログ、監査詳細、失敗レポートへ元値が新規出力されていない
- backupの保持・失効時期が正式方針に従い、期限内backupからの復元を匿名化完了と矛盾なく扱える

本番相当データを開発環境へコピーして試験しない。synthetic fixtureで実行と検証を行い、stagingでは人工の識別情報だけを使う。実データの初回実行は1件、二名立会い、実行前後の件数・制約・外部step確認を必須とする。

## 10. 監査証跡

最低限、次を追記専用で残す。

- plan ID、closure ID、user内部UUID
- retention policy version、legal review reference
- candidate snapshot hash、logic version、schema/migration version
- 対象fieldの分類と件数。元値、元値hash、置換値は保存しない
- 申請者、承認者、実行者、検証者と各UTC時刻
- 申請理由、承認理由、却下・停止理由
- DB step、外部provider step、verificationの安全な結果コード
- `STALE`、`PARTIAL_FAILURE`、再開の履歴

Idempotency-Keyはplan IDとstepから決定し、同じstepの再送で別の処理を作らない。

## 11. Rollback方針

匿名化済み識別情報を復元するrollbackは設計しない。復元可能な元値を別保存すると匿名化目的に反するためである。

代わりに次を行う。

- 実行前: snapshot不一致なら書き込みなしで停止
- DB transaction中: 失敗時はtransaction全体をrollback
- DB成功後・外部失敗: DBを元に戻さず`PARTIAL_FAILURE`として外部stepを再開
- 誤対象防止: 1件上限、二名承認、対象メール再入力ではなくclosure IDと安全な表示情報の再確認
- 業務継続: 履歴参照は内部UUIDで維持し、表示は匿名化済みラベルに切替

## 12. 実装前に確定が必要な事項

- 正式な保持日数と匿名化field allowlist
- 法的保全、本人開示・削除請求、未解決問い合わせの管理方法
- Stripe、Supabase、LINE、Resendの保持・削除・証跡条件
- 再登録時に新規会員とするか、匿名化済み内部履歴へ照合するか
- backup内識別情報の保持期限、削除、復元後の再匿名化手順
- スタッフ・公開者・確認者の表示をどこまで匿名化するか
- 承認有効時間、初回実行責任者、異常時連絡先
- 本人への完了通知、開示回答、記録保持期間

## 13. 将来の実装順

1. 正式方針とprovider回答を確定
2. Domain contractとsynthetic fixture
3. additiveなplan / event / verification model案のレビュー
4. dry-runとstale判定のunit・integration test
5. synthetic data限定の単件実行器
6. DB制約・権限・監査の検証
7. 外部provider adapterまたは手動attestation
8. desktop/mobileの申請・別管理者承認・検証E2E
9. stagingの人工データで失敗・再開・復旧不能性試験
10. 法務・運用の再承認後、別PRで本番適用を判断

自動定期実行と複数件batchは、単件運用の結果を確認したさらに後のフェーズとする。
