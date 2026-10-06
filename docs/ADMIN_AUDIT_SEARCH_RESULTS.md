# 管理者向け操作履歴検索 実装結果

## 目的

追記専用の操作履歴を、管理者が障害調査や変更確認に利用できるようにしつつ、内部IDや任意の監査詳細を画面・APIへ露出しない。

## 実装

- `ADMIN+AAL2`を維持した`GET /api/v1/admin/audit`へ、JST開始日・終了日、操作、対象種別、リクエストIDの検索を追加した。
- 期間は最大93日、リクエストIDは完全一致、操作と対象種別は大文字小文字を区別しない部分一致とした。
- レスポンスを共有Domain Contractで固定し、`actorId`と`details`を除外した。担当者名は取得したページに存在する主体だけを別照会して表示する。
- 管理画面に検索フォーム、担当者、対象、理由、JST日時、リクエストID、ページングを追加した。
- PC・スマートフォンの横幅に合わせた検索フォームと、表の横スクロールを用意した。

## 変更しないもの

- `AuditLog`のDB schema、追記専用制約、記録内容は変更しない。
- 監査詳細の閲覧、CSV出力、ログ更新・削除、本番migration、本番デプロイは行わない。

## 安全性

- 不明なquery parameter、実在しない日付、逆転期間、93日超の期間、上限超過文字列を拒否する。
- APIのstrict response schemaと結合試験で、内部`actorId`および`details`が返らないことを検証する。
- 管理画面には秘密情報・内部詳細を表示しない旨を明記する。

## 判定

ローカル検証済み。PRのCI通過後にマージ可能。本番デプロイは別判断とする。

## 検証結果

- Unit/deployment tests: 470件 PASS
- Integration: 新規1件 PASS。全回帰153件 PASS後、ローカルFlag不足で失敗した既存AI 3件をCI同等Flagで再実行してPASS（合計156件相当、Stripe live境界13件は既存どおりskip）
- E2E: desktop 1件、mobile 1件 PASS
- Typecheck: PASS
- Lint: PASS
- Production build: PASS
