import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { adminLineRichMenuResponseSchema, lineRichMenuItems, publishLineRichMenuResponseSchema, type PublishLineRichMenuInput } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import { decrypt } from './security';

const WIDTH = 2500;
const HEIGHT = 1686;
const CHAT_BAR_TEXT = 'メニューを開く';
const STALE_AFTER_MS = 5 * 60_000;

type ProviderMenu = {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: Array<{ bounds: { x: number; y: number; width: number; height: number }; action: { type: 'uri'; label: string; uri: string } }>;
};

class LineProviderError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LineProviderError'; }
}

function applicationBaseUrl() {
  return new URL(process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000');
}

export function buildLineRichMenu(baseUrl = applicationBaseUrl()) {
  const rowHeight = HEIGHT / 3;
  const items = lineRichMenuItems.map((item, index) => ({ ...item, url: new URL(item.path, baseUrl).toString(), index }));
  const provider: ProviderMenu = {
    size: { width: WIDTH, height: HEIGHT },
    selected: true,
    name: 'ウマリアル 会員メニュー',
    chatBarText: CHAT_BAR_TEXT,
    areas: items.map(item => ({
      bounds: { x: (item.index % 2) * 1250, y: Math.floor(item.index / 2) * rowHeight, width: 1250, height: rowHeight },
      action: { type: 'uri', label: item.label, uri: item.url }
    }))
  };
  return { width: WIDTH as 2500, height: HEIGHT as 1686, chatBarText: CHAT_BAR_TEXT as 'メニューを開く', items: items.map(item => ({ key: item.key, label: item.label, description: item.description, path: item.path, url: item.url })), provider };
}

export async function renderLineRichMenuPng() {
  const menu = buildLineRichMenu();
  const cells = menu.items.map((item, index) => {
    const x = (index % 2) * 1250;
    const y = Math.floor(index / 2) * 562;
    const accent = index === 0 ? '#D8A729' : '#0D665B';
    return `<g transform="translate(${x} ${y})"><rect width="1250" height="562" fill="#F8F4EA" stroke="#D8D2C3" stroke-width="5"/><rect x="75" y="78" width="12" height="270" rx="6" fill="${accent}"/><text x="130" y="118" font-size="38" letter-spacing="8" fill="#6C756F">UMAREAL</text><text x="130" y="252" font-size="82" font-weight="700" fill="#113C38">${item.label}</text><text x="130" y="333" font-size="42" fill="#58645F">${item.description}</text><path d="M1050 274h75m-28-28 28 28-28 28" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }).join('');
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#F8F4EA"/><g font-family="Noto Sans CJK JP, Yu Gothic, sans-serif">${cells}</g></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true, colours: 64 }).toBuffer();
  if (buffer.length > 1_048_576) throw new Error('Generated LINE rich menu image exceeds 1 MB.');
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

async function providerRequest(url: string, accessToken: string, init: RequestInit, fetcher: typeof fetch) {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${accessToken}`, ...init.headers } });
  } catch { throw new LineProviderError('LINE_RICH_MENU_CONNECTION_FAILED'); }
}

export async function publishToLine(provider: ProviderMenu, image: Buffer, accessToken: string, fetcher: typeof fetch = fetch) {
  const created = await providerRequest('https://api.line.me/v2/bot/richmenu', accessToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(provider) }, fetcher);
  if (!created.ok) throw new LineProviderError(`LINE_RICH_MENU_CREATE_HTTP_${created.status}`);
  const result = await created.json() as { richMenuId?: unknown };
  if (typeof result.richMenuId !== 'string' || !result.richMenuId) throw new LineProviderError('LINE_RICH_MENU_CREATE_INVALID_RESPONSE');
  const richMenuId = result.richMenuId;
  try {
    const uploaded = await providerRequest(`https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`, accessToken, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(image) }, fetcher);
    if (!uploaded.ok) throw new LineProviderError(`LINE_RICH_MENU_UPLOAD_HTTP_${uploaded.status}`);
    const selected = await providerRequest(`https://api.line.me/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`, accessToken, { method: 'POST' }, fetcher);
    if (!selected.ok) throw new LineProviderError(`LINE_RICH_MENU_DEFAULT_HTTP_${selected.status}`);
    return richMenuId;
  } catch (error) {
    try { await providerRequest(`https://api.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`, accessToken, { method: 'DELETE' }, fetcher); } catch { /* best-effort cleanup; keep the original error */ }
    throw error;
  }
}

@Injectable()
export class LineRichMenuService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private transport() {
    const value = process.env.LINE_RICH_MENU_TRANSPORT ?? process.env.NOTIFICATION_TRANSPORT;
    if (value === 'test') return 'TEST_ONLY' as const;
    if (value === 'line') return 'LINE' as const;
    return 'UNAVAILABLE' as const;
  }

  private publicationView(row: { id: string; status: string; providerRichMenuId: string | null; imageSha256: string; imageBytes: number; reason: string; createdAt: Date; completedAt: Date | null; errorCode: string | null }) {
    return { id: row.id, status: row.status, providerRichMenuId: row.providerRichMenuId, imageSha256: row.imageSha256, imageBytes: row.imageBytes, reason: row.reason, createdAt: row.createdAt, completedAt: row.completedAt, errorCode: row.errorCode };
  }

  async summary() {
    const [settings, currentPublication, attempts] = await this.auth.db.$transaction([
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineAccessTokenEncrypted: true } }),
      this.auth.db.lineRichMenuPublication.findFirst({ where: { status: 'PUBLISHED' }, orderBy: [{ completedAt: 'desc' }, { id: 'desc' }] }),
      this.auth.db.lineRichMenuPublication.findMany({ orderBy: { createdAt: 'desc' }, take: 10 })
    ]);
    let credentialsConfigured = false;
    try { credentialsConfigured = !!settings.lineAccessTokenEncrypted && decrypt(settings.lineAccessTokenEncrypted).length > 0; } catch { credentialsConfigured = false; }
    const built = buildLineRichMenu();
    return adminLineRichMenuResponseSchema.parse({ transport: this.transport(), credentialsConfigured, menu: { width: built.width, height: built.height, chatBarText: built.chatBarText, items: built.items }, currentPublication: currentPublication ? this.publicationView(currentPublication) : null, attempts: attempts.map(row => this.publicationView(row)) });
  }

  async preview() { return (await renderLineRichMenuPng()).buffer; }

  async publish(input: PublishLineRichMenuInput, actor: AuthContext, req: AppRequest) {
    const transport = this.transport();
    if (transport === 'UNAVAILABLE') throw new ServiceUnavailableException({ code: 'LINE_RICH_MENU_TRANSPORT_UNAVAILABLE', message: 'LINEメニュー公開を利用できません。連携設定を確認してください。' });
    const menu = buildLineRichMenu();
    const image = await renderLineRichMenuPng();
    const now = new Date();
    const publication = await this.auth.db.$transaction(async tx => {
      const stale = await tx.lineRichMenuPublication.findMany({ where: { status: 'PUBLISHING', createdAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } }, select: { id: true } });
      for (const item of stale) {
        await tx.lineRichMenuPublication.update({ where: { id: item.id }, data: { status: 'FAILED', completedAt: now, errorCode: 'STALE_ATTEMPT' } });
        await this.auth.audit(tx, req, 'LINE_RICH_MENU_PUBLISH_FAILED', item.id, '応答が途絶えた公開処理を終了', { errorCode: 'STALE_ATTEMPT' }, 'LINE_RICH_MENU');
      }
      const current = await tx.lineRichMenuPublication.findFirst({ where: { status: 'PUBLISHED' }, orderBy: [{ completedAt: 'desc' }, { id: 'desc' }] });
      if ((current?.id ?? null) !== input.currentPublicationId) throw new ConflictException({ code: 'LINE_RICH_MENU_STALE', message: '公開状態が更新されています。画面を再読み込みして確認してください。' });
      try {
        return await tx.lineRichMenuPublication.create({ data: { status: 'PUBLISHING', menuSnapshot: menu.provider as unknown as Prisma.InputJsonValue, imageSha256: image.sha256, imageBytes: image.buffer.length, reason: input.reason, createdBy: actor.id } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'LINE_RICH_MENU_PUBLISHING', message: '別の公開処理が進行中です。完了後に再読み込みしてください。' });
        throw error;
      }
    });

    try {
      let providerRichMenuId: string;
      if (transport === 'TEST_ONLY') providerRichMenuId = `test-richmenu-${publication.id}`;
      else {
        const settings = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineAccessTokenEncrypted: true } });
        let accessToken: string;
        try { accessToken = decrypt(settings.lineAccessTokenEncrypted ?? ''); } catch { throw new LineProviderError('LINE_RICH_MENU_CREDENTIALS_INVALID'); }
        if (!accessToken) throw new LineProviderError('LINE_RICH_MENU_CREDENTIALS_MISSING');
        providerRichMenuId = await publishToLine(menu.provider, image.buffer, accessToken);
      }
      const completedAt = new Date();
      const completed = await this.auth.db.$transaction(async tx => {
        const row = await tx.lineRichMenuPublication.update({ where: { id: publication.id }, data: { status: 'PUBLISHED', providerRichMenuId, completedAt } });
        await this.auth.audit(tx, req, 'LINE_RICH_MENU_PUBLISHED', row.id, input.reason, { transport, providerRichMenuId, imageSha256: row.imageSha256 }, 'LINE_RICH_MENU');
        return row;
      });
      return publishLineRichMenuResponseSchema.parse({ publication: this.publicationView(completed), transport });
    } catch (error) {
      const errorCode = error instanceof LineProviderError ? error.code : 'LINE_RICH_MENU_PUBLISH_FAILED';
      await this.auth.db.$transaction(async tx => {
        await tx.lineRichMenuPublication.update({ where: { id: publication.id }, data: { status: 'FAILED', completedAt: new Date(), errorCode } });
        await this.auth.audit(tx, req, 'LINE_RICH_MENU_PUBLISH_FAILED', publication.id, input.reason, { transport, errorCode }, 'LINE_RICH_MENU');
      });
      throw new ServiceUnavailableException({ code: errorCode, message: 'LINEメニューを公開できませんでした。現在のメニューはそのままです。' });
    }
  }
}
