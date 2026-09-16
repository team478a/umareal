# JRA-VAN Windows連携ブリッジ

## 現在の到達点

Windows上で、JV-Link側ですでに復号・構造化されたレース詳細（RA）と馬毎レース情報（SE）を検証し、管理画面が受け付けるレース・出走馬・結果CSVへ変換するCLIを実装しています。オフライン変換はPython標準ライブラリだけで動作し、JV-Link COM確認には公式Pythonガイドに沿ってpywin32を使います。

`doctor`、`probe`、固定長データの変換はJRA-VANサーバーへ接続しません。ライブ取得コマンドも用意していますが、Data Lab.契約、利用キー、利用条件を確認した実データ疎通は本番準備の別工程です。払戻データは読み書きしません。

JRA-VANの現行案内ではJV-Link 5.0.0はWindows 10/11と64bit CPUを対象とし、SDK 5.0.0には64bit JV-LinkとPython 3.14向け構造体・サンプルが含まれます。そのため、このブリッジはWindows/64bit/Python 3.14を基準環境にしています。

## コマンド

リポジトリ直下で実行します。

```powershell
pnpm bridge:jra-van:setup
pnpm bridge:jra-van -- doctor
pnpm bridge:jra-van -- probe
pnpm bridge:jra-van:rehearse -- --target-date 2099-09-13 --output-dir .local/jra-van-rehearsal-2099-09-13
pnpm bridge:jra-van -- convert --input tools/jra_van_bridge/samples/decoded-se.jsonl --output .local/jra-van-results.csv
pnpm bridge:jra-van -- decode-sdk-se --input .local/jvlink-se.dat --sdk-structure "<SDK展開先>\JVData_Struct.py" --output .local/jra-van-results.csv
pnpm bridge:jra-van -- decode-sdk-races --input .local/jvlink-ra.dat --sdk-structure "<SDK展開先>\JVData_Struct.py" --output .local/jra-van-races.csv
pnpm bridge:jra-van -- decode-sdk-entries --input .local/jvlink-se.dat --sdk-structure "<SDK展開先>\JVData_Struct.py" --race-date 2026-09-13 --venue-code 05 --race-number 10 --output .local/jra-van-entries.csv
pnpm bridge:jra-van -- collect-jvlink --target-date 2026-09-13 --sdk-structure "<SDK展開先>\JVData_Struct.py" --output .local/jra-van-results.csv
pnpm bridge:jra-van -- collect-jvlink-bundle --target-date 2026-09-13 --sdk-structure "<SDK展開先>\JVData_Struct.py" --output-dir .local/jra-van-2026-09-13
pnpm bridge:jra-van -- validate-bundle --input-dir .local/jra-van-2026-09-13
pnpm bridge:jra-van -- validate --input .local/jra-van-results.csv
pnpm bridge:jra-van:test
```

`setup`は`.local/jra-van-bridge-venv`へ専用環境を作り、Python 3.14用pywin32 312を固定SHA-256付きで導入します。グローバルPythonやWindowsレジストリへpywin32のpost-install処理を行いません。以降のブリッジコマンドはこの専用環境を優先します。

`doctor`はOS、プロセスのbit数、Python版、pywin32、`JVDTLab.JVLink`のCOM登録だけを読み取り、COMオブジェクトの生成、`JVInit`、JRA-VANサーバーへの通信を行いません。`jvLinkConnector`が`NOT_CONFIGURED`である間はライブ取得を実施できません。

`rehearse-bundle`は合成RA/SEをメモリ上で作り、実際の一括生成処理を通して`races.csv`、`entries/*.csv`、`results.csv`、`manifest.json`を新規ディレクトリへ作成します。その後、manifestスキーマ、全ファイルのSHA-256、余剰・不足ファイル、CSV正規形式、レースと出走馬の対応、確定結果の対応を再検証します。JV-Link COM、`JVInit`、ネットワーク、利用キーは使用しません。出力は架空データでmanifestに`sampleData: true`を持ち、診断結果は`productionImportEligible: false`となります。管理APIも開催日・結果の両取込で拒否します。本番データ確認の代わりにはなりません。

成功・失敗とも既定で一括出力の隣へ`<output-dir>.rehearsal.json`を保存します。成功時は`status: READY`、全検査の`PASS`、管理画面へ進める次の操作を記録します。失敗時は`status: FAILED`と原因を保存します。既存の一括出力は`validate-bundle`で同じ検査を行えます。診断レポートは既定で上書きせず、再作成する場合だけ`--force-report`を指定します。

`probe`は公式Pythonガイドと同じ`win32com.client.Dispatch("JVDTLab.JVLink")`でCOMオブジェクトを生成できるかだけを確認します。`JVInit`、設定画面、`JVOpen`、`JVRTOpen`、利用キーの読み取り、ネットワーク通信は行いません。JV-Link未導入時は`JVLINK_NOT_REGISTERED`で終了します。

`convert`は既存ファイルを標準では上書きしません。内容を確認して置き換える場合だけ`--force`を指定します。CSVと同時に`<出力CSV>.manifest.json`を作り、入力・出力SHA-256、件数、対象日、形式版を記録します。manifestに行データ、利用キー、絶対パスは保存しません。

`decode-sdk-se`は、JV-Linkの`JVGets`が返した馬毎レース情報（SE）だけを連結した固定長レコードファイルを、SDK 5.0.0同梱の`JVData_Struct.py`にある`JV_SE_RACE_UMA.SetDataB`で解析します。レコード長555バイト、レコード種別SEを検証し、`Year`、`MonthDay`、`JyoCD`、`RaceNum`、`Umaban`、`IJyoCD`、`KakuteiJyuni`、`Ninki`、`Odds`だけをブリッジ項目へ変換します。単勝オッズはSDKの10倍整数表現から小数1桁へ正規化します。払戻や買い目の構造体は読みません。

`decode-sdk-races`はRA固定長レコードを既存のレース登録CSVへ変換します。中央10場の平地芝・ダートだけを対象とし、開催日、競馬場、レース番号、競走名、条件名、距離、トラック、発走時刻、天候、馬場状態を変換します。既存画面で正確に表現できない障害、サンド、海外、未知コードは推測せず拒否します。担当専門家は空欄で出力し、管理画面で割り当てます。

`decode-sdk-entries`はSE固定長レコードから指定した1レースだけを抽出し、既存の出走馬CSVへ変換します。血統登録番号はUUID v5へ決定的に変換するため、同じ馬は別レースでも同じ`horseId`になります。馬番、枠番、馬名、性別、年齢、負担重量、騎手、調教師、単勝オッズ、人気、取消・除外・中止状態を変換します。入力SHA-256と出力SHA-256を`UMAREAL_JRA_VAN_RACE_ENTRY_V1` manifestへ保存します。

レース中止はSE単体から推測せず、公式の中止状態を別途確認したファイルに限り`--race-canceled`を指定します。通常と中止を同じ入力ファイルへ混在させません。SDK構造体ファイル、固定長レコード、生成CSVは`.local`などGit管理外で扱い、SDK配布物をリポジトリへ複製しません。

`collect-jvlink`はJV-Link導入・設定完了後だけ使用するライブ取得コマンドです。公式ガイドの順序どおり、`JVInit`、`JVOpen("RACE", ..., 2, ...)`、`JVStatus`、`JVGets`、`JVClose`を実行します。オプション2で今週データを開き、`JVGets`が返したレコードのうちSEだけをメモリ上で保持し、指定対象日の行だけをCSVへ出力します。RAや払戻など他のレコードは件数だけを数えて破棄し、ファイル名、固定長データ、利用キーをログ・manifest・DBへ保存しません。

ライブ取得には最大30分のタイムアウト、合計10万RA/SEレコードの安全上限、すべての正常・異常終了での`JVClose`を設けています。SID既定値は公式ガイドの開発用`UNKNOWN`です。Data Lab.利用キーをコマンド引数へ渡しません。

`collect-jvlink-bundle`は同じ公式呼出順序による1回の取得でRAとSEを分離し、対象日の取込一式を新しいディレクトリへ作ります。`races.csv`、`entries/<日付>-<競馬場コード>-<レース番号>R.csv`、`manifest.json`を出力し、対象レースの全完走馬に確定着順があるレースだけをまとめた`results.csv`を追加します。発走前・未確定のレースは結果CSVへ混ぜません。

同一開催日を再取得したときは、次のコマンドで前回と今回を比較します。

```powershell
pnpm bridge:jra-van:compare -- --previous-dir .local/jra-van-before --current-dir .local/jra-van-after
```

`compare-bundles`は両bundleを`validate-bundle`と同じ規則で検証し、成果物SHA-256と結果対象レース集合から変更なし、新たな確定結果の追加、同一レース集合の結果訂正候補、レース・出走馬変更、確定済みレースの消失を区別します。manifestだけが収集件数などで変わり、CSV成果物が同じ場合は変更なしです。比較レポートは既定で今回bundleの隣へ保存し、bundle内へ混在させません。自動取込・自動確定は行いません。

一括出力は既存ディレクトリを上書きせず、同じ親ディレクトリ内の一時領域へ全ファイルを書き終えてからディレクトリ名を確定します。RAとSEの対応不足・余剰、重複、不正値が1件でもあれば成果物を確定しません。manifestには対象日、件数、各CSVとRA/SE入力のSHA-256だけを保存し、固定長レコード自体、血統登録番号、利用キーは保存しません。

## 復号済みSE入力

SDK接続部は、1頭を1行にしたUTF-8 JSON LinesをCLIへ渡します。全項目を必須とし、値がない結果項目は`null`にします。

```json
{"recordType":"SE","raceDate":"2026-09-13","venueCode":"05","raceNumber":10,"horseNumber":1,"abnormalCode":"0","finishPosition":1,"popularity":2,"finalOdds":"3.4","raceCanceled":false}
```

入力項目は出力CSVと同じです。払戻、券種、購入額など未定義の項目がある行は拒否します。同一レース・同一馬番の重複、レース内の中止状態不一致、完走馬の着順不足、中止・非完走馬への結果値設定も拒否します。

出力は開催日、競馬場コード、レース番号、馬番で必ず並べ替え、LF改行・UTF-8・BOMなしで保存します。同じ正規化済み内容からは同じCSVとSHA-256が得られるため、管理APIの重複拒否と公式訂正識別を安定して使えます。

## 管理画面への反映

1. 一括出力を使う場合は、レース管理の「開催日一括取込」で`manifest.json`、`races.csv`、`entries`内の全CSVを選びます。SHA-256と全差分を確認し、理由を入力して全体を反映します。
2. 個別変換を使う場合は`decode-sdk-races`のCSVをレースCSV取込で反映し、各レースを開いて対応する`decode-sdk-entries`のCSVを出走馬CSV取込で反映します。
3. 結果取込では`convert`または`decode-sdk-se`後に`validate`を実行し、`canonical: true`とSHA-256を確認します。
4. 管理画面の結果管理で取込元を「JRA-VAN連携ブリッジ」にし、同じ一括出力の`results.csv`と`manifest.json`を選びます。APIがSHA-256、対象日、行数、確定レース数を照合したプレビューを下書きへ反映します。
5. レース別に公式結果を人が照合して確定します。

CLIは結果下書きや確定版を直接変更しません。管理APIもCSV反映時には下書きだけを追記し、確認済み結果版、評価結果、通知は人による確定まで作りません。

## ライブ接続を検証するときの境界

SDK同梱のPython 3.14サンプルと実端末で次を確認してから、JSON Lines生成部を追加します。

- 64bit JV-Linkの導入版、利用規約、利用キーとSIDの管理方法
- `JVOpen`と`JVRTOpen`の採用範囲、SEの確定段階、訂正データの再取得条件
- SDK 5.0.0構造体の文字コード、初期値、異常区分、競走成績確定タイミング
- JV-Linkが表示するダイアログを含む無人実行可否、再試行、監視、端末再起動手順
- 公式検証ツールとの同一レース照合と、管理画面までの開催日リハーサル

ライブ取得部はRA/SE固定長レコードの取得までを責務とし、レース・出走馬・結果CSVの変換規則はこのCLIへ集約します。利用キーをコマンド引数、固定長ファイル、CSV、manifest、ログへ出力しません。

## 公式資料

- [JRA-VAN Data Lab.](https://jra-van.jp/dlb/)（JV-Link 5.0.0の動作環境）
- [JRA-VAN SDK 5.0.0](https://developer.jra-van.jp/t/topic/45)（64bit SDK、Python 3.14構造体・サンプル）
- [SDK 5.0.0更新案内](https://developer.jra-van.jp/t/topic/959)（32bit/64bitの利用キー分離）
- [競馬ソフト開発FAQ](https://jra-van.jp/dlb/sdv/faq.html)（JV-Link、`JVOpen`、`JVRTOpen`、速報確定段階）

## 実装時の検証記録

2026年9月16日にWindows 64bit、Python 3.14.3で確認しました。

| 確認 | 結果 |
| --- | --- |
| `doctor` | `offlineReady: true`、`jvLinkConnector: READY_FOR_PROBE`、ライブ接続なし |
| ローカルCOM依存 | pywin32 312、JV-Link 5.0.0 64bit導入済み。`JVDTLab.JVLink` COM登録とAMD64実体を確認 |
| `probe` | COMオブジェクト生成成功。`JVInit`・資格情報読取・通信なし |
| SDK 5.0.0アーカイブ | 64bit公式配布物をGit管理外で確認。取得時SHA-256 `21F4D54706FF050E383F21F3571F59FFE8DE38ED46A01BE3E5B7756EE957F9D7` |
| JV-Linkインストーラー | Authenticode署名`Valid`、署名者`JRA SYSTEM SERVICE CO.,LTD.`、SHA-256 `236570C4CAAC8F3A47168D75A4AEA572E09BA60399514A3AA9ADB62EA30EDDA3` |
| SDK構造体変換 | 同梱`JVData_Struct.py`と合成1272バイトRA・555バイトSEレコードでレース、出走馬、結果CSV生成・再検証成功 |
| ライブ取得制御 | モックCOMで`JVInit → JVOpen(RACE, option 2) → JVStatus → JVGets → JVClose`、RA/SE分離、対象外レコード破棄、異常時closeを確認 |
| 対象日一括出力 | RA/SE対応検証、原子的な新規ディレクトリ確定、未確定結果の除外、固定長データ非保存を確認 |
| Pythonブリッジ単体テスト | 22件成功 |
| TypeScript単体テスト | 99件成功。レース・出走馬・結果のゴールデンCSV受入を含む |
| 結果DB/API結合テスト | 3件成功 |
| typecheck / lint / build | すべて成功 |

JV-Link 5.0.0 64bitは署名済みインストーラーをWindowsデスクトップで確認して導入し、`C:\Program Files\JRA-VAN\Data Lab`、COM登録、COMオブジェクト生成を確認しました。実契約、利用キー、`JVInit`、JRA-VANサーバーへの通信は使用していません。ライブ疎通は利用条件と資格情報を確認する別工程です。
