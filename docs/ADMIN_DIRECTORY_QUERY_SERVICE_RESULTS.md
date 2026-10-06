# 管理者ディレクトリQuery Service分離 結果

## 目的

`AppController`に残っていた管理者向け会員一覧と操作履歴の読み取り責務を、小さなQuery Serviceへ分離する。外部API、権限、画面、DB schema、監査データは変更しない。

## 基準

- 基準main: `a86670bb718caaba7a069dc75791a5732b793b2d`
- 作業branch: `refactor/admin-directory-query-service`

## 実装

- `AdminDirectoryQueryService.users`へ、既存の会員一覧ページング、限定select、共有Contract投影を移した。
- `AdminDirectoryQueryService.audit`へ、JST期間、操作・対象種別・リクエストID検索、担当者表示名解決、共有Contract投影を移した。
- Controllerには従来どおりADMIN+AAL2認可と入力検証を残した。
- 操作履歴の`details`は応答だけでなくDB selectからも除外した。`actorId`は表示名解決にのみ使用し、応答には含めない。
- Nest providerへQuery Serviceを登録した。

## 非変更範囲

- API URL、query parameter、応答項目、並び順、ページング
- ADMIN+AAL2認可
- Web画面
- DB schema、migration、既存データ
- 操作履歴の追加・更新・削除
- 本番環境

## 検証

- Query Service unit test: 2件PASS。会員一覧の限定select、操作履歴の検索条件、JST日付境界、担当者表示名、秘密情報非露出を固定した。
- 全unit/script test: 492件PASS（Vitest 472件、Node test 20件）。
- 対象integration test: 7件PASS。ADMIN+AAL2拒否、API contract、既存認証・権限境界を確認した。
- 対象E2E: desktop/mobile各1件、計2件PASS。管理者画面の検索・表示を確認した。
- `pnpm typecheck`: PASS。
- `pnpm lint`: PASS。
- `pnpm build`: PASS。

DB migrationと本番デプロイは実施していない。
