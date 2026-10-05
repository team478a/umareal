# AIレースガイド Data Provider評価表

作成日: 2026-10-05

## 評価原則

価格だけで決定しない。V1の必須field、訂正、provenance、保存・派生・表示の権利を満たさないproviderは、点数にかかわらず不採用とする。

公開Webサイトの無許可scrapingは候補にしない。通常のData Lab契約も、エンドユーザー向け商用提供のsourceとして採用しない。

## Hard Gate

次のいずれかが`NO`または書面未確認なら、Phase 1C-2のsourceとして採用しない。

| 条件 | 必須 |
| --- | --- |
| 法人Webサービスで商用利用できる | YES |
| 無料・有料・1日利用への表示ができる | YES |
| V1必須fieldを取得できる | YES |
| 正規化保存と派生Fact生成ができる | YES |
| 過去24か月・最大10走を取得・再現できる | YES |
| revision、訂正、取消・除外等を追跡できる | YES |
| provenanceとcompletenessを保存できる | YES |
| 契約終了・削除条件が実行可能 | YES |
| 書面の契約・許諾証跡がある | YES |

外部AI送信はHard Gateに含めない。`NO`ならPhase 1C-3を禁止し、Template Rendererを使用する。

## 比較項目

Hard Gate通過後、各項目を0〜5点で評価する。重み付き合計は100点。

| 分類 | 重み | 5点の基準 |
| --- | ---: | --- |
| V1 field coverage | 20 | 必須fieldと訂正情報が完全 |
| License明確性 | 20 | storage/derived/display/AIがfield/use別に明記 |
| Revision・品質 | 15 | correction、欠損、遅延、SLAが明確 |
| Provenance適合 | 10 | record reference、revision、observed timeを保持可能 |
| Integration負荷 | 10 | 既存Race/Horse/Entry/Resultへ無理なく接続 |
| Cost | 10 | 初期・継続・backfill・環境費用が予算内 |
| Retention・監査 | 5 | snapshot、backup、監査保持条件が実運用可能 |
| Support | 5 | 技術・契約窓口と応答条件が明確 |
| 将来拡張 | 5 | 馬体重、血統等を必要時だけ追加可能 |

`weightedScore = Σ(score / 5 × weight)`で算出する。ただし点数は契約上のHard Gateを上書きしない。

## Provider比較シート

| 項目 | JRADB | Provider B | 自社入力・蓄積 |
| --- | --- | --- | --- |
| 状態 | INQUIRY_REQUIRED | NOT_EVALUATED | PARTIAL |
| 商用利用 | UNKNOWN | UNKNOWN | 入力sourceごとに確認 |
| V1 field coverage | 技術候補あり、契約未確認 | UNKNOWN | 現状不足 |
| Storage | LEGAL_REVIEW_REQUIRED | LEGAL_REVIEW_REQUIRED | source依存 |
| Derived | LEGAL_REVIEW_REQUIRED | LEGAL_REVIEW_REQUIRED | source依存 |
| Display | LEGAL_REVIEW_REQUIRED | LEGAL_REVIEW_REQUIRED | source依存 |
| External AI | PROHIBITED until approved | PROHIBITED until approved | source依存 |
| Cost | UNKNOWN | UNKNOWN | 入力・運用工数 |
| Hard Gate | PENDING | PENDING | FAIL for V1 |
| Score | 未採点 | 未採点 | 未採点 |

## 選定記録

provider決定時に次を記録する。

- 評価日、評価者、承認者
- 各Hard Gateの証跡reference
- 各scoreと根拠
- 採用・不採用理由
- 契約期間、費用承認、見直し日
- fallback providerまたは停止方針

営業説明や口頭回答は補足情報として扱い、Hard Gateの証跡にしない。
