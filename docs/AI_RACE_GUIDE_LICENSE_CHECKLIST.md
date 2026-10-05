# AIレースガイド Data License Checklist

作成日: 2026-10-05

## 現在のGate

JRA-VAN公式は、Data Lab通常契約で取得したデータをエンドユーザーへ提供する商用サービスは二次利用に当たり、通常契約だけでは実施できず、法人向けJRADB契約が必要と案内している。

したがって、UMAREALはJRADBまたは別の明示的な商用契約を締結し、下記を文書で確認するまで、JRA-VAN由来データをAIレースガイドの本番Storage/Derived/Display/External AIへ`APPROVED`登録しない。

## Providerへ提示する利用形態

- 法人運営の有料・無料会員Webサービス
- 中央競馬を対象に、レース・出走馬・直近成績を保存
- 決定的集計を作り、表・説明文として会員へ表示
- 公開版、根拠、訂正履歴を監査目的で保持
- 将来、許諾された最小Factだけを第三者AIへ送信する可能性
- raw data再販売、download API、馬券購入、自動投票、モデル学習は予定しない

## 契約・商用利用

- [ ] UMAREALの法人形態で契約可能か
- [ ] 無料会員、有料会員、1日利用者への提供が可能か
- [ ] 広告、月額課金、キャンペーン価格による提供条件
- [ ] Web、モバイルWeb、将来アプリごとの条件
- [ ] 契約終了時の表示停止・削除義務
- [ ] ユーザー数、同時接続、対象レース数、端末数、利用キー数の制限

## 取得・保存・retention

- [ ] RA、SE、RCOV/RCVN、WH、WE、競走馬マスタ、血統、SLOP/WOOD、オッズの契約対象範囲
- [ ] raw recordの一時保存可否と最大期間
- [ ] 正規化fieldの永続保存可否
- [ ] hash、provider key、作成日、revision、data divisionの保存可否
- [ ] 公開versionの監査根拠として過去snapshotを保持できるか
- [ ] backup、災害復旧、log、staging環境への複製条件
- [ ] 日本国外regionや海外cloudへの保存制限

## 派生・加工

- [ ] 件数、平均着順、1着数、3着内数等の決定的集計可否
- [ ] 距離・競馬場・馬場・surface・class別Fact生成可否
- [ ] source値を直接表示せず要約だけ表示する場合の扱い
- [ ] Template Rendererによる自然文変換可否
- [ ] 派生物にも利用停止・削除義務が及ぶか
- [ ] source attribution、copyright表記、リンク要件

## 会員表示・再配信

- [ ] 原値を画面表示できるfieldと、集計のみ許されるfield
- [ ] 無料previewと有料fullで条件が異なるか
- [ ] CSV/export、印刷、スクリーンショット、キャッシュへの制限
- [ ] API responseやHTML sourceへ含められる範囲
- [ ] Horse名等の基本事実と、provider編集情報の扱いの差
- [ ] 再配信と見なされない表示方法が契約に定義されるか

## 外部AI・第三者処理

- [ ] 第三者AI事業者への送信可否
- [ ] rawではなく集計Factだけでも送信可能か
- [ ] source ID、horse external key、record referenceを除外すれば送信可能か
- [ ] provider別の事前承認、subprocessor一覧、処理region要件
- [ ] zero data retention、学習不使用、abuse monitoring保存の条件
- [ ] prompt/output/logの保存期間と削除証明
- [ ] fine-tuning、評価、モデル改善、embeddingへの利用禁止
- [ ] incident通知、監査権、契約終了時削除

未確認なら`externalAiUse=LICENSE_REVIEW_REQUIRED`、明示禁止なら`PROHIBITED`とする。Storage/Derived/Displayが承認済みでもExternal AIを自動承認しない。

## 訂正・削除・品質

- [ ] provider訂正の通知・取得方法
- [ ] data-created-at、revision、削除recordの意味
- [ ] 訂正前snapshotの監査保持可否
- [ ] 誤配信時の削除期限と会員告知義務
- [ ] 欠損、取消、除外、競走中止、レース中止の公式定義
- [ ] SLA、遅延、再取得、サポート窓口

## コスト確認

- [ ] 初期契約・審査費用
- [ ] 月額・年額
- [ ] field/dataspec/API/データ量ごとの料金
- [ ] ユーザー数、アクセス数、端末・利用キー追加料金
- [ ] 過去データ/backfill料金
- [ ] staging、開発、バックアップ利用料金
- [ ] 契約変更・解約・削除費用

Data Labの一般向け月額料金はJRADB商用契約の料金根拠にしない。JRADB料金は公開情報から推測せず、法人問い合わせで確認する。

## 証跡

各回答について次を保存する。

- provider、契約名、契約番号
- 回答日、回答者、承認者
- 契約条項・別紙・メール等の参照番号
- 対象source kind/field/use
- effectiveFrom/effectiveUntil
- policyVersionと`DataLicensePolicy.decisionReference`
- 次回review日

口頭回答だけで`APPROVED`にしない。

## 問い合わせ先と根拠

- [JRA-VAN公式: 商用利用にはJRADBが必要](https://developer.jra-van.jp/t/topic/899)
- [JRA-VAN利用規約](https://jra-van.jp/info/rule.html)
- [JRA-VAN SDK提供コーナー](https://jra-van.jp/dlb/sdv/sdk.html)

## Gate実行文書

- `docs/AI_RACE_GUIDE_COMMERCIAL_LICENSE_GATE.md`
- `docs/AI_RACE_GUIDE_JRADB_INQUIRY_DRAFT.md`
- `docs/AI_RACE_GUIDE_PROVIDER_EVALUATION.md`
- `docs/AI_RACE_GUIDE_LICENSE_DECISION_TEMPLATE.md`
