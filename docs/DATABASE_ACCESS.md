# 本番データベース権限の分離

本番PostgreSQLでは、マイグレーション所有者とAPI・workerの実行ロールを分ける。APIとworkerはテーブルの所有者にせず、CRUDと必要なsequence参照だけを許可する。

## 初回構成

1. マネージドPostgreSQLをマイグレーション所有者で作成する。`render.yaml` の既定名は `umareal_migration` とする。
2. 保護された一時実行環境に所有者接続を `DATABASE_URL` として渡し、`pnpm db:migrate` を実行する。所有者接続はAPI・workerの環境変数へ保存しない。
3. 63文字以下のruntimeロール名と強いランダムパスワードを生成し、同じDBを指すruntime接続URLを用意する。
4. 次の値をそのシェルのみに設定し、`pnpm db:access:configure` を一度実行する。

```text
DATABASE_ADMIN_URL={マイグレーション所有者のURL}
DATABASE_RUNTIME_URL={runtimeロールとパスワードを含むURL}
DB_ROLE_CONFIRM=CONFIGURE_RUNTIME_ROLE
```

CLIはruntimeロールが未作成なら作成し、`public` schemaの既存テーブルへ `SELECT / INSERT / UPDATE / DELETE` とsequenceの `USAGE / SELECT` を許可する。将来のマイグレーションで所有者が作るオブジェクトにも同じ既定権限を付与する。所有権、schema作成、`TRUNCATE`、`TRIGGER`、`REFERENCES`、特権属性、他ロールのメンバーシップがあると拒否する。URL・パスワードは出力しない。

5. APIとworkerの `DATABASE_URL` にruntime接続だけを保存する。`DATABASE_ADMIN_URL`とマイグレーション所有者のURLを常駐サービスへ渡さない。
6. runtime接続だけを設定した別のシェルで `pnpm db:access:verify` を実行する。

```text
DATABASE_RUNTIME_URL={runtime接続URL}
```

## 将来のマイグレーション

1. APIとworkerをメンテナンスまたは安全な停止状態にする。
2. Render Postgresの外部接続許可へ作業端末の現在IPだけを一時追加する。
3. Git管理外の`.env.release-db.local`へ次の3値だけを一時保存する。

```text
DATABASE_ADMIN_URL={マイグレーション所有者のURL}
DATABASE_RUNTIME_URL={runtimeロールのURL}
DB_RELEASE_CONFIRM=APPLY_MIGRATIONS_AND_VERIFY_RUNTIME
```

4. 保護された作業端末で次を実行する。

```powershell
node --env-file=.env.release-db.local scripts/prepare-release-database.mjs
```

このコマンドは所有者接続による`prisma migrate deploy`の成功後だけruntime実権限検証へ進む。両URLの接続先DB一致とロール分離も検査する。どちらかが失敗した場合はアプリを配備しない。

5. 一時IP許可と端末上の`.env.release-db.local`を削除する。所有者URLをRender、GitHub、Git、チャットへ保存しない。
6. Render Dashboardから対象mainコミットをAPI、Web、workerへ手動配備する。Blueprintは`autoDeployTrigger: off`とし、DB準備より先にアプリが自動更新されないようにする。
7. APIとworkerを起動し、`/health`、worker heartbeat、管理画面の`DATABASE_LEAST_PRIVILEGE`を確認する。production APIは起動時にも同じ実権限を検査し、所有者や過剰権限の接続を拒否する。

GitHub共有ランナーからstaging migrationは実行しない。ランナーの接続元IPは実行ごとに変わるため、Render Postgresの許可範囲を広げるか、所有者資格情報を常駐サービスへ保存する必要が生じる。作業端末の現在IPだけを一時許可する既存手順を維持し、migration後の公開状態は`Verify staging release` GitHub Actionsをmainから手動実行して再確認する。

runtimeロールは公開予想や監査履歴を更新・削除するSQL権限自体は持つが、データベースの追記専用トリガーがそれを拒否する。runtimeロールはテーブル所有者ではなくトリガー操作権限も持たないため、その保護を無効化できない。
