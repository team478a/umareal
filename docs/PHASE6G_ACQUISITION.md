# Phase 6G LP・キャンペーン流入計測

LPから無料登録、有料化までの効果を比べるため、登録URLのUTM情報をメール登録とLINE登録へ引き継ぐ。

- 対応値は `utm_source`、`utm_medium`、`utm_campaign`、`utm_content`、`utm_term`、`ref`。完全な参照元URLや任意のクエリ文字列は保存しない。
- LINE登録はOAuth開始時に値をサーバーへ保存し、登録grant経由で会員作成まで引き継ぐ。最終登録画面から流入値を再指定できない。
- UTMがない登録は `direct` として保存する。初回流入は会員ごとに1件で、更新・削除・TRUNCATEをPostgreSQLトリガーが拒否する。
- 管理ダッシュボードは直近30日の登録・有料化を流入元、媒体、キャンペーン別に上位20件表示する。計測開始前の既存会員は別件数として示す。
- 集計対象の有料化は、成功した支払取引が1件以上ある会員とする。

LPリンク例：`/register?utm_source=lp&utm_medium=owned&utm_campaign=launch`
