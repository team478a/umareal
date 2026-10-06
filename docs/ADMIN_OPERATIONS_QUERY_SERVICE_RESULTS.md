# 当日運用ボードQuery Service分離 結果

## 目的

当日運用ボードの複雑な読み取りと決定的状態判定を`AppController`から専用Query Serviceへ移す。外部仕様、運用ルール、公開・通知処理は変更しない。

## 基準

- 基準main: `439ebc4`
- 作業branch: `refactor/admin-operations-query-service`

## 実装

- `AdminOperationsQueryService.get`へ対象日のRace、担当、出走馬評価完了数、告知、予想、通知、結果、設定の限定取得を移した。
- 既存の警告、締切状態、6段階リハーサル、要確認項目、事前準備集計を同サービスへ移した。
- ControllerにはADMIN/OPERATOR認可と対象日Contract検証を残した。
- DB取得を明示的なselectへ変更し、馬名、会員連絡先、通知宛先を取得しない。設定secretは設定済み判定だけに使用し、応答へ含めない。

## 非変更範囲

- API URL、query parameter、応答項目、警告・手順の文言と順序
- ADMIN/OPERATORの既存認可
- 評価、予想、公開、通知、結果確定処理
- 管理画面
- DB schema、migration、既存データ
- 本番環境

## 検証結果

- Query Service unit: 1件成功
- operations integration: 1件成功
- 全unit: 86 files / 475 tests成功
- 全script test: 20 tests成功
- typecheck: 全5 workspace成功
- lint: 成功（warning 0）
- production build: API / Web / Worker成功
- 管理トップから当日運用ボードまでのE2E: desktop / mobile各1件成功

E2Eの初回実行は、旧ローカル`.env`に本番起動時必須の`RATE_LIMIT_PROXY_SECRET`が無く、Web proxyが500を返してログイン前に失敗した。テスト専用値をWebプロセスへ一時設定して再実行し、両projectの成功を確認した。設定ファイル、本番secret、本番環境は変更していない。

## 判定

GO。Query Service分離による外部仕様・権限・運用判定の変更はなく、DB migrationと本番デプロイも不要である。
