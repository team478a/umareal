import { describe, expect, it } from 'vitest';
import { consentVersions, legalDocumentReleaseErrors, legalDocuments, legalDocumentsReadyForProduction, type LegalDocument } from './legal';

describe('legal document release state', () => {
  it('keeps consent versions tied to the displayed document versions', () => {
    expect(consentVersions).toEqual({ terms: 'draft-v1', privacy: 'draft-v1' });
  });

  it('blocks production while either document remains a draft', () => {
    expect(legalDocumentsReadyForProduction()).toBe(false);
    expect(legalDocumentReleaseErrors()).toEqual(expect.arrayContaining([
      '利用規約 is not published',
      'プライバシーポリシー is not published'
    ]));
  });

  it('accepts complete reviewed release metadata', () => {
    const published = Object.fromEntries(Object.entries(legalDocuments).map(([key, document]) => [key, {
      ...document,
      version: '2026-09-14-v1',
      status: 'PUBLISHED',
      effectiveDate: '2026-09-14'
    }])) as Record<'terms' | 'privacy', LegalDocument>;
    expect(legalDocumentReleaseErrors(published)).toEqual([]);
  });
});
