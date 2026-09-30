import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { buildLineRichMenu, publishToLine, renderLineRichMenuPng } from './line-rich-menu.service';

describe('LINE rich menu', () => {
  it('builds six same-origin URI actions without private data', () => {
    const menu = buildLineRichMenu(new URL('https://members.example.test'));
    expect(menu.items).toHaveLength(6);
    expect(menu.provider.areas).toHaveLength(6);
    expect(menu.provider.size).toEqual({ width: 2500, height: 1686 });
    for (const area of menu.provider.areas) {
      expect(new URL(area.action.uri).origin).toBe('https://members.example.test');
      expect(area.action.type).toBe('uri');
    }
    expect(JSON.stringify(menu)).not.toMatch(/email|token|secret|subject/i);
  });

  it('renders a LINE-compatible PNG under the size limit', async () => {
    process.env.APP_BASE_URL = 'https://members.example.test';
    const image = await renderLineRichMenuPng();
    expect(image.buffer.length).toBeLessThanOrEqual(1_048_576);
    expect(image.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await sharp(image.buffer).metadata()).toMatchObject({ format: 'png', width: 2500, height: 1686 });
  });

  it('creates, uploads and selects a new default in that order', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(JSON.stringify({ richMenuId: 'richmenu-123' }), { status: 200 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const menu = buildLineRichMenu(new URL('https://members.example.test'));
    await expect(publishToLine(menu.provider, Buffer.from('png'), 'access-token', fetcher)).resolves.toBe('richmenu-123');
    expect(calls).toEqual([
      'https://api.line.me/v2/bot/richmenu',
      'https://api-data.line.me/v2/bot/richmenu/richmenu-123/content',
      'https://api.line.me/v2/bot/user/all/richmenu/richmenu-123'
    ]);
    for (const [, init] of (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls) expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer access-token' });
  });

  it('deletes only the newly-created menu when upload fails', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(JSON.stringify({ richMenuId: 'richmenu-orphan' }), { status: 200 });
      if (calls.length === 2) return new Response(null, { status: 500 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const menu = buildLineRichMenu(new URL('https://members.example.test'));
    await expect(publishToLine(menu.provider, Buffer.from('png'), 'access-token', fetcher)).rejects.toThrow('LINE_RICH_MENU_UPLOAD_HTTP_500');
    expect(calls).toEqual([
      'https://api.line.me/v2/bot/richmenu',
      'https://api-data.line.me/v2/bot/richmenu/richmenu-orphan/content',
      'https://api.line.me/v2/bot/richmenu/richmenu-orphan'
    ]);
  });
});
