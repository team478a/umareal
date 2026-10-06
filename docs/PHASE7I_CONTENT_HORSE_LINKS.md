# Phase 7I: CMSの関連馬指定

## 目的

記事・動画・音声の編集者が既存のHorseを馬名で検索し、コンテンツの関連馬として最大10頭まで指定できるようにする。公開版ごとに関連馬を固定し、後から下書きが変わっても旧版を上書きしない。

## 実装範囲

- `ContentItem`と`ContentVersion`へadditiveな`relatedHorseIds`を追加
- `ADMIN+AAL2`または`EDITOR`向けのHorse検索API
- 保存・即時公開・予約公開時の存在検証
- 公開版snapshotと関連馬ID列のDB整合性検証
- コンテンツ詳細での関連馬名表示
- Domain、DB、integration、desktop/mobile E2Eテスト

## 安全境界

- 既存Horseだけを指定し、新規Horse作成や名前一致の自動統合は行わない。
- 本文から関連馬を自動推定しない。
- Horse Cardや馬単位の公開コンテンツ一覧は作らない。
- 関連馬名は公開メタデータとし、閲覧権のない応答から本文・メディアURLを引き続き除外する。
- 本番migrationと本番デプロイは実施しない。
