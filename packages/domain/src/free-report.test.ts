import { describe, expect, it } from 'vitest';
import { adminFreeReportRaceListResponseSchema, publicFreeMemberBenefitResponseSchema, publicFreeReportMetadataResponseSchema } from './free-report';

describe('public free-member benefit contract', () => {
  it('keeps configured and unconfigured responses explicit', () => {
    expect(publicFreeMemberBenefitResponseSchema.parse({ configured: false })).toEqual({ configured: false });
    expect(publicFreeMemberBenefitResponseSchema.parse({
      configured: true,
      title: 'パドックで評価を変えた実例',
      description: '事前評価から結果検証までを解説します。',
      videoUrl: 'https://video.example.test/bonus',
      updatedAt: new Date('2026-09-28T00:00:00.000Z')
    })).toEqual({
      configured: true,
      title: 'パドックで評価を変えた実例',
      description: '事前評価から結果検証までを解説します。',
      videoUrl: 'https://video.example.test/bonus',
      updatedAt: '2026-09-28T00:00:00.000Z'
    });
  });

  it('rejects administration and identity fields', () => {
    const configured = {
      configured: true as const,
      title: '登録特典',
      description: '登録特典の説明',
      videoUrl: 'https://video.example.test/bonus',
      updatedAt: '2026-09-28T00:00:00.000Z'
    };
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ ...configured, revision: 2 }).success).toBe(false);
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ ...configured, updatedBy: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ ...configured, email: 'member@example.test' }).success).toBe(false);
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ configured: false, title: '非公開' }).success).toBe(false);
  });
});

describe('public free-report metadata contract', () => {
  const response = {
    race: {
      id: '11111111-1111-4111-8111-111111111111',
      raceDate: '2026-09-28',
      venue: '中山',
      number: 11,
      name: 'スプリンターズステークス',
      startsAt: new Date('2026-09-28T06:40:00.000Z')
    },
    versions: [{
      id: '22222222-2222-4222-8222-222222222222',
      version: 1,
      kind: 'PRE_RACE' as const,
      publishedAt: new Date('2026-09-28T06:20:00.000Z')
    }]
  };

  it('accepts an empty or published metadata history and normalizes dates', () => {
    expect(publicFreeReportMetadataResponseSchema.parse({ ...response, versions: [] }).versions).toEqual([]);
    expect(publicFreeReportMetadataResponseSchema.parse(response)).toMatchObject({
      race: { startsAt: '2026-09-28T06:40:00.000Z' },
      versions: [{ publishedAt: '2026-09-28T06:20:00.000Z' }]
    });
  });

  it('rejects horse assessments, member content and administration fields', () => {
    expect(publicFreeReportMetadataResponseSchema.safeParse({ ...response, versions: [{ ...response.versions[0], upHorseName: '非公開馬' }] }).success).toBe(false);
    expect(publicFreeReportMetadataResponseSchema.safeParse({ ...response, versions: [{ ...response.versions[0], audioUrl: 'https://media.example.test/secret.mp3' }] }).success).toBe(false);
    expect(publicFreeReportMetadataResponseSchema.safeParse({ ...response, versions: [{ ...response.versions[0], reviewText: '非公開の検証本文' }] }).success).toBe(false);
    expect(publicFreeReportMetadataResponseSchema.safeParse({ ...response, race: { ...response.race, revision: 3 } }).success).toBe(false);
  });
});

describe('admin free-report race list contract', () => {
  const response = {
    items: [{
      id: '11111111-1111-4111-8111-111111111111',
      raceDate: '2026-09-28',
      venue: '中山',
      number: 11,
      name: 'スプリンターズステークス',
      startsAt: new Date('2026-09-28T06:40:00.000Z'),
      status: 'SCHEDULED' as const,
      _count: { entries: 16 },
      freeReportDraft: { revision: 2 },
      freeReportVersions: [{
        version: 1,
        kind: 'PRE_RACE' as const,
        publishedAt: new Date('2026-09-28T06:20:00.000Z')
      }]
    }]
  };

  it('keeps list progress fields and normalizes dates', () => {
    expect(adminFreeReportRaceListResponseSchema.parse(response)).toMatchObject({
      items: [{
        startsAt: '2026-09-28T06:40:00.000Z',
        freeReportVersions: [{ publishedAt: '2026-09-28T06:20:00.000Z' }]
      }]
    });
    expect(adminFreeReportRaceListResponseSchema.parse({ items: [{ ...response.items[0], freeReportDraft: null, freeReportVersions: [] }] }).items[0]).toMatchObject({ freeReportDraft: null, freeReportVersions: [] });
  });

  it('rejects draft content, horse details and identities', () => {
    expect(adminFreeReportRaceListResponseSchema.safeParse({ items: [{ ...response.items[0], freeReportDraft: { revision: 2, upReason: '内部の評価理由' } }] }).success).toBe(false);
    expect(adminFreeReportRaceListResponseSchema.safeParse({ items: [{ ...response.items[0], entries: [{ horseName: '非公開馬' }] }] }).success).toBe(false);
    expect(adminFreeReportRaceListResponseSchema.safeParse({ items: [{ ...response.items[0], updatedBy: '22222222-2222-4222-8222-222222222222' }] }).success).toBe(false);
  });
});
