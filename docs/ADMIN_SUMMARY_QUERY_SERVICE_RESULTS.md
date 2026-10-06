# 管理ダッシュボード集計Query Service分離 結果

## 目的

管理トップの集計処理を`AppController`から読み取り専用サービスへ移し、認可とDB問合せの責務を分ける。外部仕様、集計定義、管理画面は変更しない。

## 基準

- 基準main: `0277d19`
- 作業branch: `refactor/admin-summary-query-service`

## 実装

- `AdminSummaryQueryService.get`へ既存13系統の集計と共有Contract投影を移した。
- 全期間・直近30日の登録ファネル計算をサービス内へ移した。
- source、medium、campaign単位の登録・有料化内訳を同サービスへ集約し、管理トップ、流入管理、CSV出力で再利用する。
- ControllerにはADMIN/OPERATORまたはADMIN限定の既存認可と入力検証を残した。
- 流入内訳は支払成功の存在確認に必要なIDだけを最大1件取得し、個別会員情報を返さない。

## 非変更範囲

- API URL、query parameter、応答項目
- ADMIN/OPERATORおよびADMIN+AAL2の既存認可
- 30日境界、集計条件、並び順、最大20件
- 管理画面、CSV形式
- DB schema、migration、既存データ
- 本番環境

## 検証結果

- Query Service unit test: 1件PASS。
- 全unit/script test: 494件PASS（Vitest 474件、Node test 20件）。
- auth・member-funnel・acquisition integration test: 8件PASS。
- `pnpm typecheck`: PASS。
- `pnpm lint`: PASS。
- `pnpm build`: PASS。
- ローカルstaff E2EはAPI応答が200であることを確認したが、ログイン後の画面状態更新が既存5秒待機を超え、変更箇所へ到達する前に失敗した。クリーンCIのdesktop/mobile E2Eを最終判定とする。

DB migrationと本番デプロイは実施していない。
