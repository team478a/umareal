export type LegalDocumentStatus = 'DRAFT' | 'PUBLISHED';

export type LegalDocument = {
  title: string;
  version: string;
  status: LegalDocumentStatus;
  effectiveDate: string | null;
  introduction: readonly string[];
  sections: readonly { heading: string; paragraphs: readonly string[] }[];
};

export const serviceOperator = {
  name: '和愛株式会社',
  address: '兵庫県神戸市北区大沢町簾326番地の1',
  representative: '代表取締役 森田 喜知也',
  contactEmail: 'support@umareal.com'
} as const;

export const consentVersions = {
  terms: '2026-10-01-v1',
  privacy: '2026-10-01-v1'
} as const;

const operatorContact = `${serviceOperator.name}（${serviceOperator.representative}）／所在地：${serviceOperator.address}／お問い合わせ：${serviceOperator.contactEmail}`;

// A revision must update the text, version, effective date and status together.
// Historical consent records remain append-only.
export const legalDocuments = {
  terms: {
    title: '利用規約',
    version: consentVersions.terms,
    status: 'PUBLISHED' as LegalDocumentStatus,
    effectiveDate: '2026-10-01',
    introduction: [
      'この利用規約（以下「本規約」）は、和愛株式会社（以下「当社」）が提供する競馬情報サービス「ウマリアル」（以下「本サービス」）の利用条件を定めるものです。利用者は、本規約に同意したうえで本サービスを利用します。',
      `運営者情報：${operatorContact}`
    ],
    sections: [
      {
        heading: '1. 利用資格と登録',
        paragraphs: [
          '本サービスは20歳以上の方を対象とします。登録希望者は正確かつ最新の情報を提供し、本規約およびプライバシーポリシーに同意するものとします。',
          '登録情報に虚偽、誤りまたは重複登録がある場合、当社は登録を拒否し、または利用を停止できます。'
        ]
      },
      {
        heading: '2. アカウントの管理',
        paragraphs: [
          '利用者はメールアドレス、パスワード、LINE連携その他の認証情報を自己の責任で管理し、第三者に利用させてはなりません。不正利用のおそれを認識した場合は速やかに当社へ連絡してください。'
        ]
      },
      {
        heading: '3. 提供する情報',
        paragraphs: [
          '本サービスは、中心馬、相手候補、注目馬、危険馬、信頼度、展開予想、パドック診断、選定理由、レース見解その他の競馬情報を提供します。',
          '当社は、馬券の買い目、券種、購入金額または資金配分を指定せず、馬券購入、自動投票、購入代行、賭け金の預かりを行いません。馬券を購入する場合は、利用者自身の判断と責任で行ってください。',
          '予想の的中、払戻し、利益または特定の結果を保証するものではありません。'
        ]
      },
      {
        heading: '4. 料金とクーポン',
        paragraphs: [
          '料金は税込で、1日利用は1開催日980円、月額利用は月額2,980円です。当社が発行する対象クーポンを月額利用へ適用した場合は、クーポン条件に従い1,980円となります。',
          'クーポンの対象、割引期間、利用期限および利用回数は申込画面に表示し、クーポンの併用はできません。有料プランの提供内容、支払額、利用期間、初回請求日および次回更新日は購入確定前に表示します。'
        ]
      },
      {
        heading: '5. 支払方法',
        paragraphs: [
          '有料プランの決済にはStripe, Inc.およびその関連会社が提供する決済サービスを利用します。当社はカード番号およびカードのセキュリティコードを保存しません。',
          '決済が完了しない場合または決済事業者による確認が必要な場合、当社は有料機能の提供開始を保留できます。'
        ]
      },
      {
        heading: '6. 利用期間、自動更新と解約',
        paragraphs: [
          '月額利用は購入確定前に表示された請求期間ごとに自動更新されます。利用者は次回更新日時より前にマイページまたは当社が案内する方法で解約予約を行えます。解約予約後も支払済み期間の終了までは利用できます。',
          '1日利用は申込時に指定した対象日に利用できます。対象日にWIN5予想がある場合はその初版公開時刻から、存在しない場合は対象日0時から、対象日23時59分59秒（日本標準時）までを利用期間とします。'
        ]
      },
      {
        heading: '7. 取消しと返金',
        paragraphs: [
          '通信販売にはクーリング・オフ制度は適用されません。本サービスの性質上、購入確定後または利用開始後の利用者都合による取消し、日割り計算および返金は原則として行いません。',
          '重複請求、当社の責めに帰すべき事由により有料機能を提供できなかった場合、法令上返金が必要な場合、その他当社が相当と認めた場合は、内容を確認して返金等の対応を行います。',
          '開催・レースの中止や変更、予想の不的中、閲覧の有無、利用者の通信環境または端末事情のみを理由とする返金は行いません。ただし、購入した1日利用について対象日の終了まで有料情報を一度も提供できなかった場合は、当社が利用状況を確認して個別に対応します。'
        ]
      },
      {
        heading: '8. 禁止事項',
        paragraphs: [
          '利用者は、法令または公序良俗に反する行為、不正アクセス、なりすまし、運営妨害、情報の無断転載・再配布・販売、認証情報や有料情報の共有、紹介制度やクーポンの不正利用、その他当社が不適切と判断する行為を行ってはなりません。'
        ]
      },
      {
        heading: '9. 知的財産権',
        paragraphs: [
          '本サービスの文章、画像、動画、予想、構成、商標その他のコンテンツに関する権利は、当社または正当な権利者に帰属します。利用者は私的利用の範囲を超えて無断で利用できません。'
        ]
      },
      {
        heading: '10. サービスの変更・停止',
        paragraphs: [
          '当社は、保守、障害、天災、外部サービスの停止、法令対応その他必要な場合、本サービスの全部または一部を変更または停止できます。緊急の場合を除き、重要な変更は合理的な方法で案内します。'
        ]
      },
      {
        heading: '11. 利用停止と退会',
        paragraphs: [
          '本規約への違反、不正利用、料金未払いまたは安全な運営に必要な事情がある場合、当社は利用を制限または停止できます。',
          '利用者はマイページから退会を申請できます。法令、請求、監査または不正防止のため必要な情報は、退会後も必要な期間保持することがあります。'
        ]
      },
      {
        heading: '12. 免責と責任',
        paragraphs: [
          '当社は、提供情報の正確性、完全性、最新性、特定目的への適合性および継続的な提供を保証しません。',
          '当社の故意または重過失による場合その他法令により制限できない場合を除き、当社が負う損害賠償責任は、損害の原因となった有料サービスについて利用者が直近12か月に支払った金額を上限とします。'
        ]
      },
      {
        heading: '13. 規約の変更',
        paragraphs: [
          '当社は法令またはサービス内容の変更等に応じて本規約を変更できます。重要な変更は適用日と内容を本サービス上その他合理的な方法で案内します。'
        ]
      },
      {
        heading: '14. 準拠法と管轄',
        paragraphs: [
          '本規約は日本法に準拠します。本サービスに関して紛争が生じた場合、神戸地方裁判所または神戸簡易裁判所を第一審の専属的合意管轄裁判所とします。'
        ]
      },
      { heading: '15. お問い合わせ', paragraphs: [operatorContact] }
    ]
  },
  privacy: {
    title: 'プライバシーポリシー',
    version: consentVersions.privacy,
    status: 'PUBLISHED' as LegalDocumentStatus,
    effectiveDate: '2026-10-01',
    introduction: [
      '和愛株式会社（以下「当社」）は、「ウマリアル」における利用者情報を、個人情報の保護に関する法律その他の関係法令に従い、次のとおり取り扱います。',
      `個人情報取扱事業者：${operatorContact}`
    ],
    sections: [
      {
        heading: '1. 取得する情報',
        paragraphs: [
          '当社は、メールアドレス、表示名、成人確認、規約等への同意履歴、アカウント状態、通知設定、登録経路、紹介関係、問い合わせ内容を取得します。',
          'LINEログインまたはLINE連携を利用する場合、LINEが発行する利用者識別子、表示名、連携状態およびメッセージ配信に必要な情報を取得します。',
          '有料機能では、購入プラン、金額、クーポン、契約・支払状態、請求日時、Stripeが発行する顧客・決済関連識別子を取得します。カード番号およびカードのセキュリティコードは取得・保存しません。',
          '利用に伴い、閲覧・操作履歴、通知配信結果、アクセス日時、IPアドレス、ブラウザー・端末情報、Cookie等の識別子、障害・セキュリティログを取得することがあります。'
        ]
      },
      {
        heading: '2. 利用目的',
        paragraphs: [
          '取得した情報は、本人確認と認証、会員管理、コンテンツ提供、閲覧権限判定、通知配信、紹介特典・クーポン管理、料金請求、問い合わせ対応、不正利用防止、セキュリティ確保、障害対応、サービス改善、法令遵守および監査に利用します。',
          '利用目的と合理的な関連性を超えて利用する必要が生じた場合、法令に従い通知、公表または同意取得を行います。'
        ]
      },
      {
        heading: '3. 外部サービスと委託',
        paragraphs: [
          '当社は、認証にSupabase、アプリケーションとデータベースの運用にRender、LINEログインと通知にLINEヤフー株式会社、メール配信にResend、決済にStripe、ボット対策にCloudflare Turnstileを利用します。',
          '各事業者へは機能提供に必要な範囲で情報が送信され、サーバーが日本国外に所在する場合があります。当社は委託先の安全管理措置および適用される契約・法令を確認し、必要な監督を行います。'
        ]
      },
      {
        heading: '4. 第三者提供',
        paragraphs: [
          '当社は、本人の同意がある場合、法令に基づく場合、人の生命・身体・財産の保護に必要な場合その他法令で認められる場合を除き、個人データを第三者へ提供しません。利用目的の達成に必要な範囲で取扱いを委託する場合は委託先を適切に監督します。'
        ]
      },
      {
        heading: '5. Cookie等と外部送信',
        paragraphs: [
          '本サービスは、ログイン状態の維持、セキュリティ、不正利用防止、画面機能の提供および利用状況の把握のため、Cookie、ローカルストレージその他の技術を利用することがあります。Cookieを無効にすると一部機能を利用できない場合があります。'
        ]
      },
      {
        heading: '6. 安全管理',
        paragraphs: [
          '当社は、アクセス制御、認証、暗号化、権限管理、監査ログ、委託先管理その他の合理的な安全管理措置を講じ、情報の漏えい、滅失、毀損および不正アクセスの防止に努めます。'
        ]
      },
      {
        heading: '7. 保存期間',
        paragraphs: [
          '利用目的の達成、契約・請求・同意・監査・不正防止または法令上の保存に必要な期間、情報を保持します。不要となった情報は安全な方法で削除または匿名化します。',
          '公開済み予想、同意履歴、支払・監査記録など説明責任や法令対応に必要な記録は、退会後も所定の期間保持することがあります。'
        ]
      },
      {
        heading: '8. 開示等の請求',
        paragraphs: [
          '利用者は法令に従い、本人の保有個人データについて、利用目的の通知、開示、訂正、追加、削除、利用停止、消去または第三者提供の停止を請求できます。本人確認のうえ法令で認められる範囲で対応します。'
        ]
      },
      {
        heading: '9. ポリシーの変更',
        paragraphs: [
          '当社は法令またはサービス内容の変更に応じて本ポリシーを変更できます。重要な変更は適用日と内容を合理的な方法で案内し、必要な場合は改めて同意を取得します。'
        ]
      },
      {
        heading: '10. お問い合わせ',
        paragraphs: ['個人情報の取扱いおよび開示等の請求は次の窓口へご連絡ください。', operatorContact]
      }
    ]
  }
} as const satisfies Record<'terms' | 'privacy', LegalDocument>;

export function legalDocumentReleaseErrors(documents: Record<'terms' | 'privacy', LegalDocument> = legalDocuments): string[] {
  return Object.values(documents).flatMap(document => {
    const errors: string[] = [];
    if (document.status !== 'PUBLISHED') errors.push(`${document.title} is not published`);
    if (!document.version || document.version.startsWith('draft')) errors.push(`${document.title} has a draft version`);
    const effectiveDate = document.effectiveDate;
    const parsedEffectiveDate = effectiveDate ? new Date(`${effectiveDate}T00:00:00Z`) : null;
    if (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || !parsedEffectiveDate || Number.isNaN(parsedEffectiveDate.getTime()) || parsedEffectiveDate.toISOString().slice(0, 10) !== effectiveDate) errors.push(`${document.title} has no valid effective date`);
    if (!document.introduction.length || !document.sections.length || document.sections.some(section => !section.heading || !section.paragraphs.length || section.paragraphs.some(paragraph => !paragraph))) errors.push(`${document.title} has incomplete content`);
    return errors;
  });
}

export function legalDocumentsReadyForProduction(): boolean {
  return legalDocumentReleaseErrors().length === 0;
}
