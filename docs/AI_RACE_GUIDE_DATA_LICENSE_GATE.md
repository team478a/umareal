# AIレースガイド データ利用License Gate

作成日: 2026-10-05

## 判定値

- `APPROVED`: 根拠文書に基づき当該用途を許可
- `INTERNAL_ONLY`: 内部確認だけ。会員表示や外部AI送信不可
- `LICENSE_REVIEW_REQUIRED`: 契約・権利確認が未完了
- `PROHIBITED`: 明示的に禁止

未登録は `APPROVED` とみなさず、`LICENSE_REVIEW_REQUIRED`としてfail closedする。

## 用途別判定

`DataLicensePolicy`はprovider・source kind・field・policy versionごとに、次を独立管理する。

1. `storageUse`: DB保存
2. `derivationUse`: 集計・派生Fact
3. `memberDisplayUse`: 有料・無料会員への表示
4. `externalAiUse`: 外部AI処理

例えば保存・派生・表示が `APPROVED` でも、外部AIだけ `PROHIBITED` とできる。既存policyは更新せず、新しいpolicy versionを追加する。

## Gate規則

- 会員向けFactにはstorage・derivation・member displayの3用途が全て `APPROVED` のsourceだけを使用する。
- 1つでも未確認・禁止なら、その値をFactへ入れず `NOT_AVAILABLE / LICENSE_REVIEW_REQUIRED` とする。
- 外部AI payloadはさらにexternal AIが `APPROVED` のsourceだけをallowlistへ入れる。
- provider raw record、資格情報、血統登録番号、会員情報、三国谷氏の非公開情報をpayloadへ入れない。
- `sourceRecordReference`は保存可能な内部IDまたはhashとし、raw本文をEvidenceへ複製しない。

## JRA-VAN等の現状

次は技術候補であり、利用可能との判定ではない。

| 利用 | 状態 |
| --- | --- |
| 商用会員サービスへの表示 | LICENSE_REVIEW_REQUIRED |
| raw/正規化データの永続保存 | LICENSE_REVIEW_REQUIRED |
| 条件別集計・派生Fact | LICENSE_REVIEW_REQUIRED |
| 有料会員への提供 | LICENSE_REVIEW_REQUIRED |
| 外部AIへの送信 | LICENSE_REVIEW_REQUIRED。確認前はPROHIBITED相当 |
| AI学習 | LICENSE_REVIEW_REQUIRED。Phase 1Bでは禁止 |

正式契約、SDK/仕様版、保存期間、加工、二次利用、表示、外部処理、学習利用、訂正取得を文書で確認するまで、本番利用可能とは判定しない。

## 管理者Coverage

既存DBに構造があっても対応policyが未登録なら、管理画面は `LICENSE_REVIEW_REQUIRED` を表示する。データが存在することと利用許諾済みであることを混同しない。

## 監査

- policy version、decision reference、effective期間を保持
- policy行はPostgreSQLでUPDATE/DELETE/TRUNCATE禁止
- Factからsource、Evidence、policy version、cutoff、logic versionへ追跡
- 契約変更時は新policy versionと新Fact generationを作り、公開済みsnapshotを変更しない
