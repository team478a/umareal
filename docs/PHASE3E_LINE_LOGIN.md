# Phase 3E LINE Login・会員連携の実装結果

2026年9月12日。既存会員へのLINEアカウント連携、解除、連携済み会員のLINEログインを実装した。

## 実装範囲

- LINE Login v2.1の認可URL、authorization code交換、Web用HS256 ID token検証
- state、nonce、PKCE S256、10分期限、DBによる使い切りと競合防止
- 既存ログインセッションに拘束した連携と、別会員へのsubject重複割当の拒否
- 解除時刻を残す論理解除、監査へのsubjectハッシュ記録
- 解除済みアカウントのログイン・通知・Webhook反映からの除外
- ログイン画面とマイページのLINE操作、管理画面のOAuth準備状態
- ローカルtest transportと本番起動拒否

## 検証境界

ローカルtest transportで連携、ログイン、state再利用拒否、開始セッション不一致、subject重複、解除後ログイン拒否を確認する。実LINEアカウント、保存済み本番資格情報、外部token endpointへの通信、本番デプロイは実施しない。

Callback URLはLINE Developers Consoleの登録値と完全一致させ、Messaging APIチャネルとLINE Loginチャネルを同じProvider配下に構成する運用確認が本番接続前に必要。
