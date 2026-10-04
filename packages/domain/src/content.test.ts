import { describe, expect, it } from 'vitest';
import { adminContentItemResponseSchema, contentDraftSchema, publicContentDetailResponseSchema, publicContentListResponseSchema } from './content';

const id = '11111111-1111-4111-8111-111111111111';
const draft = { kind: 'ARTICLE' as const, title: '秋競馬の見どころ', summary: '開催の注目点を紹介します。', body: '会員向けの本文です。', thumbnailUrl: null, mediaUrl: null, category: '読みもの', tags: ['秋競馬'], visibility: 'PUBLIC' as const };
const metadata = { id, version: 1, kind: 'ARTICLE' as const, title: draft.title, summary: draft.summary, thumbnailUrl: null, category: draft.category, tags: draft.tags, visibility: 'PUBLIC' as const, publishedAt: new Date('2026-10-05T01:00:00.000Z') };

describe('content CMS contracts', () => {
  it('validates media requirements and safe HTTPS URLs', () => {
    expect(contentDraftSchema.parse(draft)).toEqual(draft);
    expect(contentDraftSchema.safeParse({ ...draft, kind: 'VIDEO', mediaUrl: null }).success).toBe(false);
    expect(contentDraftSchema.safeParse({ ...draft, kind: 'AUDIO', mediaUrl: 'http://example.test/audio.mp3' }).success).toBe(false);
    expect(contentDraftSchema.safeParse({ ...draft, kind: 'VIDEO', mediaUrl: 'https://example.test/video', tags: ['重複', '重複'] }).success).toBe(false);
  });

  it('keeps locked public responses free of body and media URL', () => {
    const locked = publicContentDetailResponseSchema.parse({ ...metadata, visibility: 'PAID', locked: true });
    expect(locked.locked).toBe(true);
    expect(publicContentDetailResponseSchema.safeParse({ ...metadata, visibility: 'PAID', locked: true, body: '秘密本文' }).success).toBe(false);
    expect(publicContentDetailResponseSchema.safeParse({ ...metadata, visibility: 'PAID', locked: true, mediaUrl: 'https://example.test/private' }).success).toBe(false);
  });

  it('strictly validates administrative and public list shapes', () => {
    const item = adminContentItemResponseSchema.parse({ id, revision: 2, status: 'PUBLISHED', isVisible: true, draft, scheduledAt: null, scheduleError: null, createdAt: metadata.publishedAt, updatedAt: metadata.publishedAt, versions: [metadata] });
    expect(item.createdAt).toBe('2026-10-05T01:00:00.000Z');
    expect(adminContentItemResponseSchema.safeParse({ ...item, createdBy: id }).success).toBe(false);
    const list = publicContentListResponseSchema.parse({ items: [{ ...metadata, locked: false }], total: 1, page: 1, limit: 20, filters: { kind: 'ALL', category: null, categories: ['読みもの'] } });
    expect(list.items[0].title).toBe(draft.title);
    expect(publicContentListResponseSchema.safeParse({ ...list, items: [{ ...list.items[0], body: draft.body }] }).success).toBe(false);
  });
});
