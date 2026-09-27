import { describe, expect, it } from 'vitest';
import { publicFreeMemberBenefitResponseSchema } from './free-report';

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
