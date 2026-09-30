import { describe, expect, it } from 'vitest';
import { adminFreeMemberBenefitResponseSchema, adminFreeReportAudioUploadResponseSchema, adminFreeReportDraftResponseSchema, adminFreeReportPublishResponseSchema, adminFreeReportRaceDetailResponseSchema, adminFreeReportRaceListResponseSchema, publicFreeMemberBenefitResponseSchema, publicFreeMemberBenefitViewResponseSchema, publicFreeReportMetadataResponseSchema } from './free-report';

describe('public free-member benefit contract', () => {
  it('keeps configured and unconfigured responses explicit', () => {
    expect(publicFreeMemberBenefitResponseSchema.parse({ configured: false })).toEqual({ configured: false });
    expect(publicFreeMemberBenefitResponseSchema.parse({
      configured: true,
      title: 'パドックで評価を変えた実例',
      description: '事前評価から結果検証までを解説します。',
      updatedAt: new Date('2026-09-28T00:00:00.000Z'),
      viewedAt: null
    })).toEqual({
      configured: true,
      title: 'パドックで評価を変えた実例',
      description: '事前評価から結果検証までを解説します。',
      updatedAt: '2026-09-28T00:00:00.000Z',
      viewedAt: null
    });
  });

  it('rejects administration and identity fields', () => {
    const configured = {
      configured: true as const,
      title: '登録特典',
      description: '登録特典の説明',
      updatedAt: '2026-09-28T00:00:00.000Z',
      viewedAt: '2026-09-28T00:01:00.000Z'
    };
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ ...configured, revision: 2 }).success).toBe(false);
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ ...configured, updatedBy: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ ...configured, email: 'member@example.test' }).success).toBe(false);
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ ...configured, videoUrl: 'https://video.example.test/bonus' }).success).toBe(false);
    expect(publicFreeMemberBenefitResponseSchema.safeParse({ configured: false, title: '非公開' }).success).toBe(false);
  });

  it('returns the HTTPS playback destination only from the view action contract', () => {
    expect(publicFreeMemberBenefitViewResponseSchema.parse({ videoUrl: 'https://video.example.test/bonus', viewedAt: new Date('2026-09-28T00:01:00.000Z') })).toEqual({ videoUrl: 'https://video.example.test/bonus', viewedAt: '2026-09-28T00:01:00.000Z' });
    expect(publicFreeMemberBenefitViewResponseSchema.safeParse({ videoUrl: 'http://video.example.test/bonus', viewedAt: '2026-09-28T00:01:00.000Z' }).success).toBe(false);
  });
});

describe('admin free-member benefit contract', () => {
  it('preserves unconfigured and configured responses while normalizing dates', () => {
    expect(adminFreeMemberBenefitResponseSchema.parse({
      id: 'global', title: '', description: '', videoUrl: '', revision: 0, updatedAt: null, audience: { eligibleMembers: 2, viewedMembers: 1 }
    })).toEqual({ id: 'global', title: '', description: '', videoUrl: '', revision: 0, updatedAt: null, audience: { eligibleMembers: 2, viewedMembers: 1 } });
    expect(adminFreeMemberBenefitResponseSchema.parse({
      id: 'global',
      title: 'パドックで評価を変えた実例',
      description: '事前評価から結果検証までを解説します。',
      videoUrl: 'https://video.example.test/bonus',
      revision: 2,
      updatedBy: '11111111-1111-4111-8111-111111111111',
      updatedAt: new Date('2026-09-28T00:00:00.000Z'),
      audience: { eligibleMembers: 2, viewedMembers: 1 }
    })).toMatchObject({ revision: 2, updatedAt: '2026-09-28T00:00:00.000Z' });
  });

  it('rejects credentials, relations and a changed unconfigured shape', () => {
    const configured = {
      id: 'global',
      title: '登録特典',
      description: '登録特典の説明',
      videoUrl: 'https://video.example.test/bonus',
      revision: 1,
      updatedBy: null,
      updatedAt: '2026-09-28T00:00:00.000Z',
      audience: { eligibleMembers: 2, viewedMembers: 1 }
    };
    expect(adminFreeMemberBenefitResponseSchema.safeParse({ ...configured, passwordHash: 'secret' }).success).toBe(false);
    expect(adminFreeMemberBenefitResponseSchema.safeParse({ ...configured, user: { email: 'admin@example.test' } }).success).toBe(false);
    expect(adminFreeMemberBenefitResponseSchema.safeParse({ id: 'global', title: '', description: '', videoUrl: '', revision: 0, updatedAt: null, updatedBy: null, audience: { eligibleMembers: 0, viewedMembers: 0 } }).success).toBe(false);
  });
});

describe('admin free-report write contracts', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const raceId = '22222222-2222-4222-8222-222222222222';
  const upEntryId = '33333333-3333-4333-8333-333333333333';
  const downEntryId = '44444444-4444-4444-8444-444444444444';
  const actorId = '55555555-5555-4555-8555-555555555555';

  it('keeps audio, draft and publication success responses explicit', () => {
    expect(adminFreeReportAudioUploadResponseSchema.parse({ id, url: `/api/v1/free-report-audio/${id}`, contentType: 'audio/webm', sizeBytes: 8 })).toMatchObject({ id, sizeBytes: 8 });
    expect(adminFreeReportDraftResponseSchema.parse({ id, raceId, upEntryId, upReason: '良化', downEntryId, downReason: '気配平凡', audioUrl: `/api/v1/free-report-audio/${id}`, reviewText: '', revision: 1, updatedBy: actorId, updatedAt: new Date('2026-09-28T00:00:00.000Z') })).toMatchObject({ revision: 1, updatedAt: '2026-09-28T00:00:00.000Z' });
    expect(adminFreeReportPublishResponseSchema.parse({ id, version: 1, kind: 'PRE_RACE', publishedAt: new Date('2026-09-28T00:05:00.000Z') })).toMatchObject({ version: 1, publishedAt: '2026-09-28T00:05:00.000Z' });
  });

  it('rejects mismatched audio paths, database relations and credentials', () => {
    expect(adminFreeReportAudioUploadResponseSchema.safeParse({ id, url: `/api/v1/free-report-audio/${raceId}`, contentType: 'audio/webm', sizeBytes: 8 }).success).toBe(false);
    expect(adminFreeReportDraftResponseSchema.safeParse({ id, raceId, upEntryId, upReason: '良化', downEntryId, downReason: '気配平凡', audioUrl: 'https://media.example.test/audio.mp3', reviewText: '', revision: 1, updatedBy: actorId, updatedAt: '2026-09-28T00:00:00.000Z', race: { id: raceId } }).success).toBe(false);
    expect(adminFreeReportPublishResponseSchema.safeParse({ id, version: 1, kind: 'PRE_RACE', publishedAt: '2026-09-28T00:05:00.000Z', token: 'secret' }).success).toBe(false);
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

describe('admin free-report race detail contract', () => {
  const upEntryId = '22222222-2222-4222-8222-222222222222';
  const downEntryId = '33333333-3333-4333-8333-333333333333';
  const response = {
    id: '11111111-1111-4111-8111-111111111111',
    raceDate: '2026-09-28',
    venue: '中山',
    number: 11,
    name: 'スプリンターズステークス',
    startsAt: new Date('2026-09-28T06:40:00.000Z'),
    status: 'FINISHED' as const,
    entries: [
      { id: upEntryId, number: 1, horseName: '上昇馬', status: 'ACTIVE' as const },
      { id: downEntryId, number: 2, horseName: '下降馬', status: 'ACTIVE' as const }
    ],
    freeReportDraft: {
      id: '44444444-4444-4444-8444-444444444444',
      raceId: '11111111-1111-4111-8111-111111111111',
      upEntryId,
      upReason: '踏み込みが力強い。',
      downEntryId,
      downReason: '落ち着きを欠く。',
      audioUrl: '/api/v1/free-report-audio/55555555-5555-4555-8555-555555555555',
      reviewText: '評価どおりの走りでした。',
      revision: 2,
      updatedBy: '66666666-6666-4666-8666-666666666666',
      updatedAt: new Date('2026-09-28T06:25:00.000Z')
    },
    freeReportVersions: [{
      id: '77777777-7777-4777-8777-777777777777',
      version: 1,
      kind: 'PRE_RACE' as const,
      upHorseNumber: 1,
      upHorseName: '上昇馬',
      upReason: '踏み込みが力強い。',
      downHorseNumber: 2,
      downHorseName: '下降馬',
      downReason: '落ち着きを欠く。',
      audioUrl: '/api/v1/free-report-audio/55555555-5555-4555-8555-555555555555',
      reviewText: null,
      publishReason: '発走前の会員公開',
      publishedAt: new Date('2026-09-28T06:30:00.000Z')
    }],
    resultVersions: [{
      id: '88888888-8888-4888-8888-888888888888',
      version: 1,
      confirmedAt: new Date('2026-09-28T07:00:00.000Z')
    }]
  };

  it('keeps editable detail and publication history while normalizing dates', () => {
    expect(adminFreeReportRaceDetailResponseSchema.parse(response)).toMatchObject({
      startsAt: '2026-09-28T06:40:00.000Z',
      freeReportDraft: { updatedAt: '2026-09-28T06:25:00.000Z' },
      freeReportVersions: [{ publishedAt: '2026-09-28T06:30:00.000Z' }],
      resultVersions: [{ confirmedAt: '2026-09-28T07:00:00.000Z' }]
    });
    expect(adminFreeReportRaceDetailResponseSchema.parse({ ...response, freeReportDraft: null, freeReportVersions: [], resultVersions: [] })).toMatchObject({ freeReportDraft: null, freeReportVersions: [], resultVersions: [] });
  });

  it('rejects database relations, credentials and unselected publication fields', () => {
    expect(adminFreeReportRaceDetailResponseSchema.safeParse({ ...response, email: 'admin@example.test' }).success).toBe(false);
    expect(adminFreeReportRaceDetailResponseSchema.safeParse({ ...response, freeReportDraft: { ...response.freeReportDraft, passwordHash: 'secret' } }).success).toBe(false);
    expect(adminFreeReportRaceDetailResponseSchema.safeParse({ ...response, freeReportVersions: [{ ...response.freeReportVersions[0], publishedBy: '66666666-6666-4666-8666-666666666666' }] }).success).toBe(false);
    expect(adminFreeReportRaceDetailResponseSchema.safeParse({ ...response, freeReportVersions: [{ ...response.freeReportVersions[0], notificationEvent: { id: '99999999-9999-4999-8999-999999999999' } }] }).success).toBe(false);
  });
});
