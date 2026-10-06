# 管理者向け退会記録Query Service分離 結果

## 目的

管理者向け退会記録一覧のDB問合せと応答投影を`AppController`から既存`AccountClosureService`へ移し、退会領域の読み取り境界を明確にする。外部仕様と退会処理は変更しない。

## 基準

- 基準main: `ea7d9c4`
- 作業branch: `refactor/admin-account-closure-query`

## 実装

- `AccountClosureService.list`へ既存のページング、並び順、状態投影、共有Contract検証を移した。
- AccountClosureと画面表示に必要な会員5項目だけを明示的にselectする。
- Controllerには従来どおりADMIN+AAL2認可とページング入力検証を残した。
- password hash、認証subject、MFA secret、決済・通知情報を取得・返却しないことをunit testで固定した。

## 非変更範囲

- API URL、query parameter、応答項目、ページング、並び順
- ADMIN+AAL2認可
- 管理画面
- 会員本人の退会可否判定・退会処理
- 保持方針、保持preview
- DB schema、migration、既存データ
- 本番環境

## 検証結果

- AccountClosureService unit test: 10件PASS。
- 全unit/script test: 493件PASS（Vitest 473件、Node test 20件）。
- 既存account-closure integration test: 4件PASS。
- 既存staff E2E: 退会記録画面をdesktop/mobileで確認。全体初回は後続の継続運用画面でmobile 1件が待機timeoutとなったが、同シナリオの単独再実行はPASS。
- `pnpm typecheck`: PASS。
- `pnpm lint`: PASS。
- `pnpm build`: PASS。

DB migrationと本番デプロイは実施していない。
