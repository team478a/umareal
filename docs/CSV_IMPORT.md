# レース登録とCSV取込

管理者はログイン・二段階認証後に `/admin/races` を開きます。運営担当も利用できます。通常レースの結果は発走後に `/admin/results` から取り込みます。

1. 開催日・競馬場を登録し、表示日を選びます。レース登録やCSVでも開催日が自動作成されます。
2. 「レースを追加」で項目と担当専門家、理由を入力し保存します。
3. レースの「編集・出走馬」から馬を追加します。同じ馬には以前と同じ馬ID（UUID）を指定します。登録済み馬の変更は一覧の「編集」を使います。
4. CSV取込の対象を選び、サンプルをダウンロードします。出走馬CSVは対象レースを開いてから取り込みます。
5. UTF-8で保存したCSVを選び、「差分を確認」で追加・変更・変更なしと変更前後を確認します。
6. 理由を入力し「内容を確認して取り込む」で確定します。プレビューだけではレース・出走馬は変わりません。

確認から15分経過、または別操作で対象が変更された場合は再プレビューしてください。通信エラー後の同じ確定ボタンの再送は重複反映されません。手動編集が競合した場合は再読み込みし、変更を確認して入力し直します。

## 形式

UTF-8（BOM可）、カンマ区切り、最大200データ行。画面のファイル選択は64KB以内。ヘッダーはサンプルと同じ順序・全列必須です。カンマ・改行・引用符を含む値はCSVの引用ルールを使います。文字項目の先頭の `= + - @`、不正な制御文字は拒否します。

レースCSV：

```csv
raceDate,venue,number,name,raceClass,distance,surface,direction,startsAt,going,weather,status,expertId
```

- raceDate: 実在するYYYY-MM-DD。venue: 札幌/函館/福島/新潟/東京/中山/中京/京都/阪神/小倉。
- number: 1〜12、distance: 400〜5000m、name/raceClass/weather: 空欄不可。
- surface: TURF/DIRT。direction: RIGHT/LEFT/STRAIGHT。
- startsAt: `2099-09-12T15:00:00+09:00` のようなタイムゾーン付き日時。JSTの日付とraceDateを一致させます。
- going: GOOD/YIELDING/SOFT/HEAVY/UNKNOWN。
- status: SCHEDULED/ACTIVE/DELAYED/FINISHED/CANCELLED。
- expertId: 有効な専門家のUUID、空欄は未割当。再取込で空欄にすると現在の担当を解除します。

出走馬CSV：

```csv
horseId,number,gate,horseName,sex,age,carriedWeight,jockey,trainer,winOdds,popularity,status
```

- horseId: UUID。number: 1〜18、gate: 1〜8、horseName/jockey/trainer: 空欄不可。
- sex: MALE/FEMALE/GELDING。age: 2〜30。
- carriedWeight: 30〜80kg、小数1桁まで。
- winOdds: 1〜99999.9、小数1桁まで。popularity: 1〜18。どちらも空欄は未確認。
- status: ACTIVE/SCRATCHED/EXCLUDED/STOPPED。

レースは開催日＋競馬場＋レース番号、出走馬は対象レース＋馬番で照合します。同じファイル内の重複と、同じレースへの同一馬IDの複数登録を拒否します。CSVにない行は保持します。馬番の移動やレース照合キーの変更はこの画面では扱いません。取消・除外・中止は削除せず状態として記録します。

JRA-VANブリッジの`decode-sdk-races`はRA固定長レコードをこのレースCSVへ、`decode-sdk-entries`は指定した1レースのSE固定長レコードをこの出走馬CSVへ変換します。血統登録番号は決定的UUIDへ変換し、同じ馬の`horseId`を維持します。中央10場の平地芝・ダートだけを対象とし、障害、海外、未知コードはプレビュー前に拒否します。担当専門家はCSVへ自動設定しません。

ライブ運用向けの`collect-jvlink-bundle`は1回のJV-Link取得から`races.csv`とレース別の`entries/*.csv`を新規ディレクトリへ原子的に作成します。既存ディレクトリは上書きせず、RAとSEの対象レースが一致しない場合は全体を失敗させます。各CSVは上記と同じ管理画面のプレビューを通して反映します。

管理画面へ投入する前に`validate-bundle --input-dir <一括出力>`を実行すると、manifest、全SHA-256、CSVの正規形式、余剰・不足ファイル、レース・出走馬・結果の対応を再検証し、隣に診断レポートを保存します。ライブ接続なしの手順確認には`pnpm bridge:jra-van:rehearse -- --target-date <架空日> --output-dir <新規ディレクトリ>`を使います。リハーサル成果物は`sampleData: true`であり、本番取込には使用しません。

同じ開催日を再取得した場合は、`pnpm bridge:jra-van:compare -- --previous-dir <前回bundle> --current-dir <今回bundle>`を実行します。両方を完全検証したうえで、`UNCHANGED`、`RESULTS_AVAILABLE`、`RESULT_CORRECTION_CANDIDATE`、`RACE_DATA_CHANGED`、`REVIEW_REQUIRED`のいずれかを外部レポートへ保存します。`UNCHANGED`は再投入せず、新たな確定結果の追加・同一レース集合の訂正候補は結果管理、レース・出走馬変更は開催日一括取込でプレビューします。`REVIEW_REQUIRED`は確定済みレースの消失を示すため投入せず公式発表を確認します。CLIはAPI送信、下書き反映、結果確定を行いません。

管理画面の「開催日一括取込」では、生成された`manifest.json`、`races.csv`、`entries`内の全CSVを選択します。サーバーはmanifestの形式版、対象日、ファイル一覧、件数、各ファイルのSHA-256、レースと出走馬ファイルの対応を再検証します。差分確認ではデータを変更せず、理由を入力して15分以内に確定した場合だけ、対象日の全レースと全出走馬を1トランザクションで反映します。1ファイルでも不足・改変・競合があれば全体を反映しません。

manifestに`results.csv`が含まれる場合、画面は結果があることだけを案内します。結果は開催日一括取込では反映せず、発走後に`/admin/results`で別途プレビューし、人が公式結果と照合してから下書きへ反映・確定します。

サンプルは架空データです。正式データの取得と利用はJRA-VAN Data Lab.の契約・利用条件に従います。

## 結果CSV

結果管理で対象レースを選び、登録された全出走馬を含むUTF-8 CSVを読み込みます。差分確認ではデータを変更せず、確認した担当者が15分以内に理由を入力して確定した場合だけ結果下書きへ反映します。取込後も結果は未確定です。画面で着順・取消・除外・競走中止を照合し、別の「結果を確定」操作を行うと評価結果と通知が作成されます。

```csv
number,status,finishPosition,popularity,finalOdds
```

- number: 対象レースへ登録済みの馬番1〜18。全馬を1回ずつ指定し、未登録・重複・不足を拒否します。
- status: FINISHED（完走）/WITHDRAWN（取消）/EXCLUDED（除外）/DNF（競走中止）/CANCELED（レース中止）。
- finishPosition: 完走馬は1〜18が必須です。完走以外は空欄にします。
- popularity: 1〜18。未確認は空欄にします。
- finalOdds: 整数または小数1桁の確定単勝。未確認は空欄にします。
- レース中止の場合は画面の「レース中止として取り込む」を有効にし、全馬のstatusをCANCELED、着順を空欄にします。

列はこの5項目だけです。払戻、券種、買い目、購入金額、回収率は受け付けません。プレビュー後に対象レース、出走馬、または結果下書きが変わった場合は再プレビューが必要です。

### 複数レース形式

結果管理の一覧上部では、取込元を選び、複数レースを1ファイルで確認できます。`内部標準CSV`は次の形式です。

```csv
raceDate,venue,raceNumber,horseNumber,status,finishPosition,popularity,finalOdds
```

- raceDate、venue、raceNumberで登録済みレースを照合します。
- horseNumberはそのレースの馬番です。各レースについて全登録馬を1回ずつ指定します。
- status以降の規則は1レース形式と同じです。あるレースを中止にする場合、そのレースの全馬をCANCELEDにします。
- CSV内のレース行は混在順でも構いません。最大200データ行です。

プレビューではレース別の差分と反映後の下書き版を表示します。1行でも不正、未登録、不足、発走前のレースがあればbatchを作成しません。確定時に1レースでも変更競合があれば、他のレースを含めて一切反映しません。取込済みレースは一覧へ「CSV取込済み・確認待ち」と表示されます。各レースを開いて公式結果を照合し、個別に結果確定してください。

### JRA-VAN連携ブリッジ形式

JRA-VAN Data Lab.のJV-DataはJV-Linkから取得する固定長データであり、Webへ直接アップロードしません。Windows上の連携ブリッジが馬毎レース情報（SE）を次のUTF-8 CSVへ変換し、管理画面で取込元を`JRA-VAN連携ブリッジ`に切り替えて読み込みます。

```csv
recordType,raceDate,venueCode,raceNumber,horseNumber,abnormalCode,finishPosition,popularity,finalOdds,raceCanceled
```

- recordType: `SE`のみ。払戻（HR）など他のレコードは出力しません。
- raceDate: ブリッジが`YYYY-MM-DD`へ正規化した開催日。
- venueCode: JRA-VAN競馬場コード`01`〜`10`。ウマリアル側で中央10場の名称へ変換します。
- abnormalCode: JRA-VAN異常区分コード`0`〜`7`。`0/6/7`は完走、`1`は取消、`2/3/5`は除外、`4`は競走中止へ変換します。完走扱いは確定着順が必須です。
- raceCanceled: `true`または`false`。`true`の場合は対象レースの全馬を指定し、着順、人気、確定単勝を空欄にします。
- finishPosition、popularity、finalOdds: ブリッジが文字コード・固定長・初期値を処理した後の値。確定単勝は倍率の小数表記です。

ブリッジ形式は`UMAREAL_JRA_VAN_BRIDGE_V1`として版管理します。プレビューには取込元、形式版、アップロード内容のSHA-256指紋を表示します。確定時はこの3項目を結果下書きと監査ログへ保存し、元CSV、JV-Link利用キー、払戻データは保存しません。

オフライン変換CLIは[Windows連携ブリッジ手順](JRA_VAN_BRIDGE.md)に従って実行します。復号済みSE JSON Linesを厳格検証し、決定的なCSVとSHA-256 manifestを生成できます。JRA-VANとの利用契約、JV-Linkの導入、SDKサンプルとJSON Lines生成部の接続、ライブデータ疎通は公開準備の別作業です。

一括出力に`results.csv`が含まれるのは、対象レースの完走扱い全馬に確定着順が揃った場合だけです。未確定レースはファイルへ混在させません。結果管理では同じ一括出力の`manifest.json`を任意で選択できます。選択時はAPIが形式版、results.csvのSHA-256、対象日、行数、確定レース数を再検証し、改変や取り違えがあれば下書きを作りません。従来の単体ブリッジCSVも互換性のため受け付けます。結果CSVが存在しても自動確定は行わず、管理画面で公式結果とのプレビュー・照合・確定が必要です。

### 再取込と公式訂正

- 同じ取込元と同じSHA-256指紋の確定済みCSVは、プレビューと確定の両方で重複として拒否します。並行して作成した複数のプレビューも、最初の確定後は残りを確定できません。
- 同じ取込元・同じ対象レース集合でファイル指紋が変わった場合、プレビューへ前回取込時刻を表示し、`公式訂正`として新しい結果下書き版を作ります。前回の下書き、確定結果版、監査履歴は変更しません。
- 管理画面の「最近の取込履歴」には、初回／公式訂正、取込元、形式版、担当者、確定時刻、ファイル指紋、検証済みbundle対象日、対象レース、反映した下書き版を表示します。元CSV・manifest本文は表示・保存しません。
- PostgreSQLの部分一意索引でも、確定済みの取込元＋ファイル指紋の重複を拒否します。公式訂正は内容が異なるため別の指紋となり、前回batch IDを保持します。

参照仕様： [JRA-VAN Data Lab. SDK提供コーナー](https://jra-van.jp/dlb/sdv/sdk.html)、[JV-Data仕様書 Ver.4.9.0.1](https://jra-van.jp/dlb/sdv/sdk/JV-Data4901.pdf)、[JV-LinkとJV-Dataの概要](https://jra-van.jp/dlb/sdv/about.html)。
