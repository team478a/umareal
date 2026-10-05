# AIレースガイド Data License Decision Record

作成日: 2026-10-05
状態: TEMPLATE — provider回答待ち

## 契約情報

| 項目 | 値 |
| --- | --- |
| provider | TBD |
| 契約名 | TBD |
| 契約番号 | TBD |
| effectiveFrom | TBD |
| effectiveUntil | TBD |
| 次回review日 | TBD |
| provider担当部署・担当者 | TBD |
| UMAREAL確認者 | TBD |
| UMAREAL承認者 | TBD |
| decisionReference | TBD（機密本文ではなく安全な保管先ID） |

## 判定値

- `APPROVED`: 契約書面で許可を確認
- `INTERNAL_ONLY`: 内部処理だけ許可、会員表示・外部送信不可
- `LICENSE_REVIEW_REQUIRED`: 未回答、曖昧、条件未確定
- `PROHIBITED`: 明示禁止または契約対象外

未回答を`APPROVED`にしない。provider全体の包括回答だけでfield/use別判定を自動承認しない。

## V1 source/use判定

| Source kind | Fields | Storage | Derived | Display | External AI | Retention | Evidence reference | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RA相当 | 開催、競馬場、番号、名称、class、surface、distance、direction、going、weather、start、field size | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | PROHIBITED | TBD | TBD | V1必須 |
| SE相当 | horse identity、name、sex/age、gate/number、weight、jockey、trainer、status | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | PROHIBITED | TBD | TBD | V1必須 |
| 過去走RA/SE相当 | date、course、surface、distance、going、class、finish、abnormal status | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | PROHIBITED | TBD | TBD | 24か月・最大10走 |
| Source metadata | revision、data-created-at、record reference、import information | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | INTERNAL_ONLY | PROHIBITED | TBD | TBD | provenance用 |
| 現在馬体重 | body weight、change | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | PROHIBITED | TBD | TBD | V1任意 |
| 血統 | sire、dam、damsire | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | PROHIBITED | TBD | TBD | Phase 2候補 |
| 調教・追切 | training records | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | PROHIBITED | TBD | TBD | Phase 2以降 |
| 時系列オッズ | odds snapshots | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | LICENSE_REVIEW_REQUIRED | PROHIBITED | TBD | TBD | Phase 2以降 |

## 表示条件

| 項目 | 回答 | 証跡 |
| --- | --- | --- |
| 無料preview | TBD | TBD |
| 有料full | TBD | TBD |
| 1日利用 | TBD | TBD |
| 原値表示 | TBD | TBD |
| 派生Fact表示 | TBD | TBD |
| 固定Template文章 | TBD | TBD |
| 出典・copyright表記 | TBD | TBD |
| CSV/export/API制限 | TBD | TBD |
| screenshot・cache制限 | TBD | TBD |

## 外部AI判定

| 項目 | 回答 | 証跡 |
| --- | --- | --- |
| 最小Fact送信 | PROHIBITED until approved | TBD |
| raw data送信 | PROHIBITED | policy |
| external key/source ID送信 | PROHIBITED | policy |
| model training/fine-tuning | PROHIBITED | policy |
| zero data retention要件 | TBD | TBD |
| processing region | TBD | TBD |
| subprocessor事前承認 | TBD | TBD |
| prompt/output log保持 | TBD | TBD |

## 訂正・終了時対応

| 項目 | 回答 | 証跡 |
| --- | --- | --- |
| source訂正通知 | TBD | TBD |
| 訂正版取得方法 | TBD | TBD |
| 旧snapshot監査保持 | TBD | TBD |
| 誤配信時削除期限 | TBD | TBD |
| 契約終了時削除期限 | TBD | TBD |
| 派生Fact削除義務 | TBD | TBD |
| backup消去期限 | TBD | TBD |

## 最終判定

| Gate | 判定 | 根拠 |
| --- | --- | --- |
| Phase 1C-2 Storage | PENDING | provider回答待ち |
| Phase 1C-2 Derived | PENDING | provider回答待ち |
| Phase 1C-2 Display | PENDING | provider回答待ち |
| Phase 1C-3 External AI | NO-GO | 書面許諾なし |
| 総合 | NO-GO | provider契約・回答未確定 |

## 承認

- 技術確認者: TBD
- 法務確認者: TBD
- 運営責任者: TBD
- 承認日: TBD
- 承認範囲: TBD

一部fieldだけ承認された場合は、承認fieldのallowlistを明記し、それ以外を`PROHIBITED`または`LICENSE_REVIEW_REQUIRED`のまま維持する。
