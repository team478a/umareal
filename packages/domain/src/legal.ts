export type LegalDocumentStatus = 'DRAFT' | 'PUBLISHED';

export type LegalDocument = {
  title: string;
  version: string;
  status: LegalDocumentStatus;
  effectiveDate: string | null;
  introduction: readonly string[];
  sections: readonly { heading: string; paragraphs: readonly string[] }[];
};

export const consentVersions = {
  terms: 'draft-v1',
  privacy: 'draft-v1'
} as const;

// Legal text is deliberately code-managed for the initial release. A reviewed
// replacement must update the body, version, effective date and status together.
export const legalDocuments = {
  terms: {
    title: '利用規約',
    version: consentVersions.terms,
    status: 'DRAFT' as LegalDocumentStatus,
    effectiveDate: null as string | null,
    introduction: ['正式なサービス提供条件は未確定です。この文書は開発と検証にのみ使用します。'],
    sections: [
      { heading: '対象者と利用範囲', paragraphs: ['登録時には20歳以上であることを確認します。この開発環境では馬券の購入、購入代行、自動投票、料金の決済を行いません。'] },
      { heading: '公開前の確認', paragraphs: ['正式な運営者情報、提供条件、料金・解約・返金条件を確定し、審査済み文書への同意を別途取得してから本番運用します。'] }
    ]
  },
  privacy: {
    title: 'プライバシーポリシー',
    version: consentVersions.privacy,
    status: 'DRAFT' as LegalDocumentStatus,
    effectiveDate: null as string | null,
    introduction: ['正式なプライバシーポリシーは未確定です。この文書は開発と検証にのみ使用します。'],
    sections: [
      { heading: '保存する情報', paragraphs: ['メールアドレス、表示名、同意日時、通知設定、登録時の流入情報、申込導線の到達情報、操作履歴を開発用データベースに保存します。認証情報は選択した認証方式に応じて認証基盤または開発用データベースで管理します。'] },
      { heading: '入力する情報', paragraphs: ['この開発環境に実在する個人の情報を入力しないでください。'] }
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
