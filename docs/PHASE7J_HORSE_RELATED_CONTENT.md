# Phase 7J: 馬別の関連コンテンツ導線

## 目的

CMSで関連馬が設定された公開コンテンツから、その馬に関する他の公開記事・動画・音声を安全に探せるようにする。

## 実装範囲

- `GET /horses/:horseId/content`
- コンテンツ詳細の関連馬リンク
- `/horses/:horseId`の関連コンテンツ一覧
- 最新公開版、公開中状態、既存閲覧権限を使ったサーバー側絞り込み
- Domain、integration、desktop/mobile E2E

## 安全境界

- 公開メタデータだけを一覧へ返し、本文とメディアURLは返さない。
- 有料コンテンツは既存権限で`locked`を判定する。
- 下書き、旧版だけの関連、公開終了コンテンツを表示しない。
- Horse external identity、血統、過去走、AIガイド、三国谷評価は表示しない。
- DB schema、本番migration、本番デプロイは変更しない。
