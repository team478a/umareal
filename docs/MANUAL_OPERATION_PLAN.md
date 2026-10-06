# JRA-VAN未接続 初期運用 実装計画

作成日: 2026-10-06

## Phase 1: 最小限の未接続運用（今回）

- `RACE_DATA_MODE`を未設定時`MANUAL`として解決する。
- 管理画面へ「手動運用・正常・外部データ連携未使用」を表示する。
- JRA-VAN bundle UIは削除せず、手動モードでは補助的な折りたたみ領域にする。
- SDK/JV-Link/API keyなしで起動、レース、予想、公開、結果、成績が動く回帰試験を維持する。

## Phase 2: 入力簡略化（今回）

- RaceEntry詳細属性をnullableへ緩和する後方互換migration。
- 馬番・馬名・理由だけの「かんたん出走馬登録」を追加する。
- Horse UUIDをサーバー生成する。
- `HorseExternalIdentity(provider=MANUAL)`を作り、暫定Identityを明示する。
- 同名候補を`POSSIBLE_DUPLICATE`として返し、自動mergeしない。
- 詳細未登録を画面で「未確認」と表示し、後から既存詳細編集で補完できるようにする。

## Phase 3: Basic Guide（今回は安全境界のみ）

- 手動Entryの詳細不足を`INSUFFICIENT_DATA`として扱い、架空の値を生成しない。
- AIを使わない固定template rendererは別のreviewable phaseで検討する。
- 三国谷氏コメントの整理は、ORIGINAL/AI_DRAFT/APPROVED、License Gate、人の承認設計が確定するまで実装しない。
- AIの勝率、印、危険馬、買い目、自動公開は実装しない。

## Phase 4: 将来Provider接続準備（境界を維持）

- 現在の`RaceDataProvider` / `ResultDataProvider` Adapterを維持する。
- 正式契約後にprovider固有Adapterを追加し、内部Race/RaceEntry/Result contractへ変換する。
- 暫定Horseと正式external identityの照合は候補提示＋人の確認とし、自動mergeしない。
- source revisionは既存のSTALE・新versionフローへ接続する。
- License Gate未承認の保存・派生・表示・外部AI送信を許可しない。

## 完了判定

今回のPhase 1/2は、JRA-VAN設定なしで以下を確認して完了とする。

1. アプリ起動
2. 手動レース作成
3. 馬番＋馬名で全出走馬登録
4. パドック評価・予想作成
5. 追記専用公開版の会員表示
6. 手動結果下書き・確定
7. 成績保存
8. AI入力で不足属性を推測しない
9. 管理画面が手動運用を正常と表示
10. CSV/JRA-VAN Adapterの既存テストを維持

本番deploy、本番migration、JRA-VANライブ接続、スクレイピング、外部AI接続は別承認とする。
