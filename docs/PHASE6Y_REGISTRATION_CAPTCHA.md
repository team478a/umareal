# Phase 6Y 無料登録入口のBot対策

## 完成条件

- メール会員登録にCloudflare Turnstileを表示し、未回答または不正な回答を会員作成前に拒否する。
- 管理者+AAL2が管理画面から有効化、Site key、Secret keyの保存・削除、準備状態の確認を行える。
- Secret keyを暗号化保存し、設定API、監査履歴、ログへ値を返さない。
- 本番はCloudflare Siteverify、ローカルとCIは外部通信を行わない試験transportを使う。
- 公開準備画面で有効化、資格情報、Secret復号、transport、公開URLをまとめて判定する。

## 境界

Turnstileの対象は公開メール登録だけとする。ログイン、確認メール再送、パスワード再設定、LINE Providerを通るLINE登録には追加しない。既存のAPIレート制限は維持する。複数APIインスタンス向け共有レート制限は別ゴールで扱う。

本番の外部疎通、Cloudflare側widget作成、公開hostname登録、実端末試験は公開作業として別に実施する。管理画面に資格情報を保存しても外部接続済みとは表示しない。
