import { describe, expect, it } from 'vitest';
import { adminLineRichMenuResponseSchema, lineLoginReturnPathSchema, lineRichMenuItems, publishLineRichMenuSchema } from './line-rich-menu';

describe('LINE rich menu contracts', () => {
  it('keeps the six fixed destinations safe and relative', () => {
    expect(lineRichMenuItems).toHaveLength(6);
    for (const item of lineRichMenuItems) {
      expect(lineLoginReturnPathSchema.parse(item.path)).toBe(item.path);
      expect(item.path.startsWith('/')).toBe(true);
      expect(item.path.startsWith('//')).toBe(false);
    }
  });

  it('requires an explicit baseline and reason before publication', () => {
    expect(publishLineRichMenuSchema.parse({ currentPublicationId: null, reason: '初回公開' })).toEqual({ currentPublicationId: null, reason: '初回公開' });
    expect(publishLineRichMenuSchema.safeParse({ currentPublicationId: null, reason: '' }).success).toBe(false);
    expect(publishLineRichMenuSchema.safeParse({ currentPublicationId: null, reason: '公開', extra: true }).success).toBe(false);
  });

  it('does not expose credentials or LINE user identifiers', () => {
    const response = {
      transport: 'TEST_ONLY' as const,
      credentialsConfigured: true,
      menu: { width: 2500 as const, height: 1686 as const, chatBarText: 'メニューを開く' as const, items: lineRichMenuItems.map(item => ({ ...item, url: `https://example.test${item.path}` })) },
      currentPublication: null,
      attempts: []
    };
    expect(adminLineRichMenuResponseSchema.parse(response)).toEqual(response);
    expect(adminLineRichMenuResponseSchema.safeParse({ ...response, channelAccessToken: 'secret' }).success).toBe(false);
    expect(adminLineRichMenuResponseSchema.safeParse({ ...response, lineUserId: 'U123' }).success).toBe(false);
  });
});
