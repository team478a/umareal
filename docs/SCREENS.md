# 画面と権限

| URL | 画面 | 対象 |
| --- | --- | --- |
| / | ホーム、対象レース、最新の対象レース告知。ログイン中は未読・LINE受信・会員プランと次の操作 | 全員。予想本文なし |
| /register | LINEを主経路にした無料登録、メール登録 | 全員 |
| /register/line | LINE認証後の表示名・成人・規約同意確認 | 有効な登録grant |
| /verify-email | 登録メール・予備メールの確認、登録メール再送 | 全員 |
| /login | メール認証または連携済みLINEアカウントでログイン | 開発認証／LINE Login有効時 |
| /forgot-password | 再設定依頼 | 開発認証 |
| /reset-password | 再設定リンクの処理 | 有効なトークン |
| /account | 利用準備チェックリスト、会員情報、予備メール、LINE連携・受信状態・解除、通知設定、同意履歴 | 本人 |
| /notifications | 対象レース告知・最終予想・訂正版のWeb履歴、未読絞り込み、レース詳細への移動 | 本人。予想イベントは現在の閲覧権限で制御 |
| /races | 開催日・競馬場・告知/公開状態によるレース一覧、公開範囲と訂正版表示 | 全員。予想本文なし |
| /plans | 税込料金、申込内容の最終確認、創設会員・通常会員・1日利用の開発用申込 | 全員。申込は本人 |
| /results | 公開版別の的中率、回収率、本命成績と条件別参考集計 | 全員 |
| /security | TOTP登録・認証 | 本人 |
| /expert | 担当レース一覧、事前評価、1頭ずつのパドック入力、全頭進捗・履歴 | 担当EXPERT/ADMIN、AAL2 |
| /races/:raceId | 無料会員向けパドック速報・音声・レース後検証、最新の公開予想と旧版・訂正版の切替、有料ロック時の料金確認導線 | 全員。無料速報本文はログイン会員、予想本文は公開範囲・有限期間権限による |
| /admin | 管理ダッシュボード。30秒自動更新・鮮度表示付きの日付別開催日運用ボード、6段階の開催日リハーサル、運用状況、会員転換ファネル | ADMIN+AAL2/OPERATOR |
| /admin/races | 開催日・レース・出走馬・担当専門家・CSV差分確認・スマホ向け対象レース告知 | ADMIN+AAL2/OPERATOR |
| /admin/free-reports | 登録特典動画、評価UP/DOWN各1頭、本人音声、レース後検証の下書き・公開履歴 | ADMIN+AAL2/OPERATOR |
| /admin/publication-schedules | 対象レース告知・無料速報の予約、取消、公開遅延・予約失敗・通知失敗アラート | ADMIN+AAL2/OPERATOR |
| /admin/settings | LINE・Stripe資格情報、料金、通知再試行方針、緊急停止 | ADMIN+AAL2。OPERATORはAPIで状態のみ閲覧可 |
| /admin/notifications | 配送状態、試行履歴、状態フィルター、理由付き再送 | ADMIN+AAL2/OPERATOR |
| /admin/incidents | 公開・取込・通知の停止、通知遅延・失敗・停滞、初動から復旧までの手順、会員向け案内文案 | ADMIN+AAL2/OPERATOR |
| /admin/backups | 最終バックアップ・隔離復元結果、ハッシュ、件数照合、実施手順 | ADMIN+AAL2 |
| /admin/readiness | 本番準備の確認済み・要対応・人による確認、根拠と対応先 | ADMIN+AAL2 |
| /admin/account-closures | 退会処理済み会員、利用停止日時、退会理由、保持方針 | ADMIN+AAL2 |
| /admin/results | 発走後の着順・状態・払戻入力、確定履歴、成績再計算 | ADMIN+AAL2/OPERATOR |
| /admin/billing | 契約期間・猶予、1日利用、支払履歴、外部決済申込、Stripe Webhook受信、test時のみローカル失敗/回復試験 | ADMIN+AAL2 |
| /admin/users | 会員一覧 | ADMIN+AAL2 |
| /admin/audit | 操作履歴 | ADMIN+AAL2 |
| /terms、/privacy | コード管理された版付き法務文書。現在は開発用 | 全員 |

LINE認証→成人・規約同意→無料会員、またはメール入力→確認URL→無料会員。管理者/専門家はログイン→セキュリティ→TOTP確認→担当/管理画面。画面の分岐と独立にAPIでも権限を確認する。
