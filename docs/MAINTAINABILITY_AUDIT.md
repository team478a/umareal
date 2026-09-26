# 保守・拡張性監査

監査日: 2026-09-26

基準: `origin/main` `898142558b7b25752235122ea1c7834346677706`

対象: 既存挙動を変えない開発規則、CI品質ゲート、将来の分割候補

この文書は実装済みの機能、PRだけに存在する機能、CIで確認した範囲、実環境で未確認の範囲を混同しないための監査記録である。認証、課金、紹介、閲覧権限、予想公開の業務仕様を変更する承認には使用しない。設計候補の実装時は `docs/SPEC.md` と `docs/DECISIONS.md` を改めて確認し、別PRで判断を記録する。

## 現在の状態

| 区分 | 確認内容 |
| --- | --- |
| `main`へ統合済み | 紹介制度V1と本番準備修正。基準SHAは上記。紹介制度の詳細は `docs/REFERRAL_SYSTEM.md` を正とする |
| ブランチ・PRだけ | `feat/billing-operations-completion`、PR #1「feat: complete billing exception operations」。監査時点でbaseは`main`、checks成功、mergeable。請求例外運用は`main`へ未統合 |
| CIで確認済み | mainのActions run `36128067936`。typecheck、lint、単体33ファイル142件、配備事前確認5件、JRA-VAN 22件、DB/API結合36ファイル108件、desktop/mobile E2E 38件、全workspace build、Docker build、本番起動ガードが成功 |
| CIで意図的に未実行だった範囲 | 上記runではStripe専用結合1ファイル6件が`BILLING_TRANSPORT=test`によりskip。本PRで外部通信しない専用段階を追加する |
| 実環境・実機で未確認 | 本番Supabase、LINE Login/Messaging、Resend到達、Stripe sandbox/liveの外部API、独自ドメイン、実機iPhone、本番DB migration・制限ロール・バックアップ復元 |

テスト件数は監査時点の証跡であり、CIの合否条件には固定値として埋め込まない。追加した必須テスト段階は、対象が0件、skip、todo、失敗のいずれでも失敗させる。

## CIの検証範囲

| 段階 | コマンド・仕組み | 使用環境 | 保証する範囲 | 保証しない範囲 |
| --- | --- | --- | --- | --- |
| 生成・DB | `pnpm db:generate`, `pnpm db:migrate` | 毎回作るPostgreSQL 16 CI DB | Prisma生成、全migrationの新規DB適用 | 本番既存データ量、停止時間、運用者権限 |
| 静的検査 | `pnpm typecheck`, `pnpm lint` | 全workspace | 型とlint規則 | 実行時の外部サービス挙動 |
| 単体 | `pnpm test` | Node、mock中心 | domain/API/worker/Web単体、配備事前確認 | PostgreSQL・ブラウザ結合 |
| JRA-VAN | Python unittest | 合成fixture | オフライン変換・検証 | JV-Link契約、実データ取得 |
| DB/API結合 | `pnpm test:integration` | PostgreSQL、local auth、test transports、直列実行 | DB制約、API認可、監査、通知・請求のローカル経路 | 外部プロバイダーへの送信・請求 |
| Stripeローカル結合 | `pnpm test:integration:stripe-local` | Stripe形式の署名とtest-mode設定、外部通信なし | 署名、不一致、冪等Webhook、DB反映、設定元 | Checkout Session作成、Stripe CLI、テストカード、live決済 |
| ブラウザE2E | `pnpm test:e2e` | Chromium desktop/iPhone 13 viewport、local transports | 実ブラウザ導線、モバイル幅 | Safari実機、外部OAuth・メール到達 |
| build・起動防御 | `pnpm build`, Docker build, production guard | 合成された安全な設定 | 生成物作成、危険な本番設定の拒否 | クラウド基盤への配備と疎通 |

DB/API結合とE2Eは同じDBの全体設定やシングルトン行を扱うため、現状の `fileParallelism: false` と段階間のAPI再起動を維持する。速度だけを理由に無差別な並列化は行わない。

## 監査項目

### MA-001 Stripe専用結合テストの可視性

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `.github/workflows/ci.yml`, `package.json`, `scripts/run-required-vitest.mjs`, `tests/stripe-billing.integration.test.ts`
- 問題: 通常の結合段階ではStripe専用6件がskipされるため、CI全体の成功だけではStripe形式Webhookのローカル検証済み／未検証を区別しにくい。
- 影響: 署名、冪等性、金額不一致、契約ライフサイクルの回帰を見落とす可能性がある。
- 対応: 外部Stripe APIを呼ばない専用段階で既存テストを実行する。対象が0件、skip、todoの場合も失敗するランナーを使用する。既存テスト内容と請求機能コードは変更しない。
- 優先度: P0
- 検証: `BILLING_TRANSPORT=stripe`とtest-mode用の合成設定で `pnpm test:integration:stripe-local`。外部通信を行うCheckout作成はこの段階の対象外。

### MA-002 開発規則の時点依存

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `AGENTS.md`
- 問題: 冒頭の許可範囲が過去フェーズに固定され、現在の`main`や個別依頼の範囲と一致しなくなっていた。
- 影響: 過去の許可を新しい変更や本番操作へ誤って適用するおそれがある。
- 対応: 永続的な安全規則と現在フェーズの決め方を分離し、既存の保護規則を維持する。
- 優先度: P0
- 検証: 本番配備、ライブ資格情報、業務仕様変更が個別承認であること、および既存の公開版・認可・秘密情報・テスト規則が残ることをレビューする。

### MA-003 PR説明の必須情報

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `.github/pull_request_template.md`
- 問題: PRテンプレートがなく、API/DB影響、未実行試験、rollbackがレビューごとに抜ける可能性がある。
- 影響: レビュー時に本番影響と検証境界を判断しにくい。
- 対応: 目的、範囲、API/DB、検証、未実行、rollback、安全確認を含む小さなテンプレートを追加する。
- 優先度: P1
- 検証: 新規PR作成時にテンプレートが表示され、該当なしも明記できることを確認する。

### MA-004 API責務の集中（後続PR候補）

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `apps/api/src/auth.controller.ts`（387行）、`apps/api/src/app.controller.ts`（481行）、`apps/api/src/billing.controller.ts`（532行）
- 問題: HTTP入出力、認可、DB問合せ、外部プロバイダー変換、監査の複数責務がcontrollerへ集まり、変更時の影響範囲が大きい。
- 影響: 認証Cookie、AAL2、課金冪等性、閲覧権限などの重要境界を局所的に検証しにくい。
- 提案: 最初の実装候補は読み取り専用の管理readiness問合せをquery serviceへ移す。次に認証の登録／セッション／MFA orchestration、請求のprovider gateway／Webhook適用処理を別PRで分離する。endpoint、transaction、AuditLog、error codeは維持する。
- 優先度: P1
- 検証: 分離前後でAPI contract、DB/API結合、AAL1/AAL2拒否、冪等性、既存E2Eが同じ結果になることをcharacterization testで固定する。

### MA-005 DBアクセス境界（後続PR候補）

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `apps/api/src/app.controller.ts`, `apps/api/src/auth.service.ts`, `packages/db/prisma/schema.prisma`（1447行）
- 問題: controllerが共有Prisma clientを通して多数の集計を直接組み立てており、読み取り形状と認可前提がコード上で分散している。
- 影響: schema変更の波及が大きく、不要フィールド返却や認可条件の漏れをレビューしにくい。
- 提案: readinessの読み取り専用queryをpilotにし、入力、select、返却型を限定する。全repository化やPrismaの一括置換は行わない。
- 優先度: P2
- 検証: SQL回数・返却項目・権限・既存readiness E2Eを比較し、migrationなしで完了させる。

### MA-006 共有API contract（後続PR候補）

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `apps/api/src/referrals.controller.ts`, `apps/web/components/media-app.tsx`, `packages/domain/src`
- 問題: APIの実行時validationとWeb側の応答型が、機能によって個別に保守されている。
- 影響: nullable項目、状態名、権限制限の変更でサーバーと画面がずれる可能性がある。
- 提案: 既に安定している紹介の読み取りAPIを候補に、公開してよい応答だけをdomain packageのschemaから型導出する。秘密情報を含むDB modelの共有や全面移行はしない。
- 優先度: P2
- 検証: APIの無料／本人／管理者応答、モバイル画面、既存紹介integration/E2Eを固定する。

### MA-007 CIジョブ構成

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象ファイル: `.github/workflows/ci.yml`, `vitest.integration.config.ts`, `playwright.config.ts`
- 問題: 1つの`validate`ジョブに全段階が入り、無名のstepが多いため、失敗した保証範囲の把握に時間がかかる。
- 影響: 障害切り分けが遅くなり、skipと未実行が見落とされやすい。
- 対応: 今回はstep名とStripe専用段階だけを追加する。DB共有と順序依存を理解せずjobを分割しない。
- 優先度: P1
- 検証: clean CI DBで全段階を実行し、失敗箇所がActions画面のstep名から分かることを確認する。

### MA-008 main保護設定

- 基準SHA: `898142558b7b25752235122ea1c7834346677706`
- 対象: GitHub repository settings（コード変更対象外）
- 問題: 監査時点でGitHub APIは`main`を「Branch not protected」と返し、repository rulesetも存在しなかった。
- 影響: CI未通過や未レビューの変更をmainへ直接反映できる。
- 提案: 管理者がGitHub上でmainへのPR必須、1名以上の承認、stale approvalの破棄、conversation解決、status check `validate`、force push・削除禁止を設定する。運用が安定したら管理者にも適用する。
- 優先度: P0（人による設定）
- 検証: 設定後にテストPRで未承認、CI失敗、force pushが拒否されることを確認する。今回のPRではGitHub設定を変更しない。

## 後続PRの順序

1. PR #1の請求例外運用をmainへ統合するか判断し、競合を解消する。
2. 読み取り専用readiness queryを小さなpilotとして分離し、既存の認可・E2Eを固定する。
3. 紹介読み取り応答の共有schemaを1領域だけ試し、APIから返さない情報が増えていないことを確認する。
4. 認証と請求の分離はそれぞれ独立PRにし、同時に大規模リファクタリングしない。

どの段階でも既存migrationの書換え、公開済み予想・監査履歴の変更、本番データ操作、外部課金、実会員通知を含めない。

## 本番外の確認手順

コードの品質確認が完了しても、公開判定では次を別に実施する。

1. Supabase本番相当環境で登録、メール確認、refresh、logout、AAL2を確認する。
2. LINEの許可CallbackとMessaging対象を限定して実アカウント試験する。
3. Resendの認証済みドメインで確認メール、通知、bounce webhookを確認する。
4. Stripe sandboxで実際のCheckout、テストカード、Stripe CLIまたはDashboard webhook、重複、不一致、返金運用を確認する。live keyはsandbox試験に使用しない。
5. 独自ドメイン、HTTPS、Origin、Cookie、noindexを確認する。
6. 実機iPhone Safariで会員・紹介・専門家・管理画面の主要導線を確認する。
7. 本番migrationはバックアップ、制限付きruntime role、実行計画、rollback判断、責任者を確認して別作業で実行する。
