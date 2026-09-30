import { Body, Controller, ForbiddenException, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { canManage, publishLineRichMenuSchema, requiresMfa } from '@keiba/domain';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { LineRichMenuService } from './line-rich-menu.service';

@Controller('admin/line-rich-menu')
export class LineRichMenuController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(LineRichMenuService) private readonly richMenu: LineRichMenuService) {}

  private async admin(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN'])) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'LINEメニュー管理には管理者権限と二段階認証が必要です。' });
    return actor;
  }

  @Get()
  async summary(@Req() req: AppRequest) { await this.admin(req); return this.richMenu.summary(); }

  @Get('preview')
  async preview(@Req() req: AppRequest, @Res() res: Response) {
    await this.admin(req);
    const image = await this.richMenu.preview();
    res.set({ 'Content-Type': 'image/png', 'Content-Length': String(image.length), 'Cache-Control': 'private, no-store' });
    return res.send(image);
  }

  @Post('publish')
  async publish(@Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.admin(req);
    return this.richMenu.publish(publishLineRichMenuSchema.parse(body), actor, req);
  }
}
