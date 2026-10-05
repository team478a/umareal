# AIレースガイド Commercial Data License Gate

作成日: 2026-10-05
基準main: `0c3c96e6610e7636c84b6b83b62e368a99e3d2e3`

## 目的

Phase 1C-2で実データ取込を実装する前に、採用provider、対象field、利用目的、保持条件を契約書面で確定する。技術的に取得できることを利用許諾とみなさない。

このGateを通過するまで、JRA-VAN/JRADB等の実データをUMAREAL本番DBへ保存せず、会員へ表示せず、外部AIへ送信しない。

## 現在の状態

| 項目 | 状態 | 理由 |
| --- | --- | --- |
| Data Lab通常契約 | REJECTED | エンドユーザー向け商用提供には使用しない |
| JRADB法人契約 | INQUIRY_REQUIRED | 契約範囲、料金、field/use別条件が未確認 |
| 別商用provider | NOT_EVALUATED | 同一checklistで比較が必要 |
| 自社入力・自社蓄積 | PARTIAL | 入力元と第三者権利を別途確認する必要がある |
| 外部AI送信 | PROHIBITED | 書面許諾が得られるまで0 field |

## Gateの段階

### Gate 1: 法人・サービス適格性

- 和愛株式会社として契約可能
- UMAREALの無料会員、有料会員、1日利用への提供形態をproviderが理解
- Webサービスでの商用利用が契約対象
- 予想補助情報であり、馬券購入・自動投票サービスではないことを確認

### Gate 2: V1 source/field適格性

最低限、次のsourceまたは同等情報について回答を得る。

- 現在レース: RA相当
- 現在出走馬: SE相当
- 過去24か月・各馬最大10走: RA/SEまたはRCOV/RCVN相当
- source revision、訂正、取得時刻を追跡できる情報

V1必須ではないWH、WE速報、血統、調教、時系列オッズは契約候補として質問するが、未回答でもV1 Gateを失敗にしない。

### Gate 3: 用途別許諾

field/source単位で次を独立判定する。

1. `storageUse`: 正規化値、識別子、revision、監査snapshotを保存できる
2. `derivedUse`: 件数・平均・条件別成績等の決定的Factを生成できる
3. `displayUse`: 無料preview、有料full、1日利用へ原値または派生値を表示できる
4. `externalAiUse`: 第三者AI事業者へ最小Factを送信できる

口頭説明、一般的なパンフレット、料金表だけでは`APPROVED`にしない。契約条項、別紙、またはprovider担当者からの書面回答を必要とする。

### Gate 4: 運用・保持条件

- raw record一時保持期間
- 正規化値、派生Fact、公開snapshot、backupの保持期間
- 開発、staging、本番、災害復旧への複製条件
- 海外cloud region、委託先、subprocessor条件
- source訂正・削除時の再取得、停止、削除、会員告知義務
- 契約終了時の停止・削除期限と監査証跡の保持可否

### Gate 5: 費用・承認

- 初期、月額/年額、backfill、データ量、利用者数、環境追加の費用を確定
- 契約期間、更新、解約、値上げ条件を確定
- UMAREAL運営責任者と法務確認者が契約書面と実装範囲を承認
- 承認内容を`DataLicensePolicy.decisionReference`へ紐付けられる状態にする

## 必須証跡

- provider名、契約名、契約番号
- 問い合わせ日、回答日、担当部署・担当者
- 契約条項、別紙、メール等の参照先
- 対象source kind、field、use
- `APPROVED / INTERNAL_ONLY / LICENSE_REVIEW_REQUIRED / PROHIBITED`
- effectiveFrom、effectiveUntil、次回review日
- retention、attribution、削除条件
- UMAREAL側承認者と承認日時

契約書・メール本文そのものに機密情報がある場合、リポジトリへ保存しない。アクセス制御された保管先の文書IDまたはURLだけをdecision referenceへ記録する。

## GO条件

Phase 1C-2へ進めるのは、次をすべて満たす場合だけとする。

- V1必須fieldの`storageUse`が`APPROVED`
- V1必須fieldの`derivedUse`が`APPROVED`
- 会員に出すfield/Factの`displayUse`が`APPROVED`
- 過去24か月・最大10走の取得、保存、訂正運用が許諾範囲内
- provenance、completeness、監査snapshotの保持条件が明確
- 契約終了・削除・訂正時の運用が明確
- 費用と契約を運営責任者が承認

`externalAiUse`はPhase 1C-2のGO条件ではない。禁止または未確認ならTemplate Rendererを使用し、Phase 1C-3を開始しない。

## NO-GO条件

- 有料会員への表示が禁止
- 派生Fact生成が禁止
- 必要な過去走範囲を保存または再現できない
- source revisionや訂正を追跡できない
- 利用範囲が口頭回答のみで確定しない
- 費用または契約義務を運営責任者が承認しない

## 実行順

1. `AI_RACE_GUIDE_JRADB_INQUIRY_DRAFT.md`を法人情報と返信先で最終確認
2. JRA-VANサポートデスクへJRADB紹介を依頼
3. provider回答を`AI_RACE_GUIDE_LICENSE_DECISION_TEMPLATE.md`へ転記
4. 必要に応じて別商用providerへ同じ質問を提示
5. `AI_RACE_GUIDE_PROVIDER_EVALUATION.md`で比較
6. 運営・法務承認
7. Phase 1C-2の実装範囲を承認済みfieldだけで確定

問い合わせ送信は外部コミュニケーションであるため、送信者と返信先を人が確認してから行う。

## 公式根拠

- [JRA-VAN公式: 競馬データの商用利用のお問い合わせについて](https://developer.jra-van.jp/t/topic/899)
- [JRA-VAN利用規約](https://jra-van.jp/info/rule.html)
