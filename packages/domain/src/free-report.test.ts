import { describe, expect, it } from 'vitest';
import { publicFreeMemberBenefitResponseSchema, publicFreeReportMetadataResponseSchema } from './free-report';

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
