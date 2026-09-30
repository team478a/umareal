import { describe, expect, it } from 'vitest';
import { consentVersions, legalDocumentReleaseErrors, legalDocuments, legalDocumentsReadyForProduction, serviceOperator, type LegalDocument } from './legal';

describe('legal document release state', () => {
  it('keeps consent versions tied to the displayed document versions', () => {
    expect(consentVersions).toEqual({ terms: '2026-10-01-v1', privacy: '2026-10-01-v1' });
  });

  it('publishes complete documents for the launch date', () => {
    expect(legalDocumentsReadyForProduction()).toBe(true);
    expect(legalDocumentReleaseErrors()).toEqual([]);
    expect(legalDocuments.terms.effectiveDate).toBe('2026-10-01');
    expect(legalDocuments.privacy.effectiveDate).toBe('2026-10-01');
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

  it('continues to reject draft metadata before a future revision is released', () => {
    const draft = Object.fromEntries(Object.entries(legalDocuments).map(([key, document]) => [key, {
      ...document,
      version: 'draft-next',
      status: 'DRAFT',
      effectiveDate: null
    }])) as Record<'terms' | 'privacy', LegalDocument>;
    expect(legalDocumentReleaseErrors(draft)).toEqual(expect.arrayContaining([
      '利用規約 is not published',
      '利用規約 has a draft version',
      'プライバシーポリシー is not published',
      'プライバシーポリシー has a draft version'
    ]));
  });

  it('does not publish capital information', () => {
    expect(serviceOperator).not.toHaveProperty('capital');
    expect(JSON.stringify(legalDocuments)).not.toContain('資本金');
  });
});
