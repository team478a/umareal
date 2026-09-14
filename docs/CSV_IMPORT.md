# レース登録とCSV取込

管理者はログイン・二段階認証後に `/admin/races` を開きます。運営担当も利用できます。

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

サンプルは架空データです。正式データ提供元や利用許諾は未確定です。結果・払戻CSVはPhase 3で追加します。
