import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { canManage, requiresMfa } from '@keiba/domain';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

export const adminManualFiles = {
  'dashboard': 'admin-01-dashboard.mp4',
  'race-registration': 'admin-02-race-registration.mp4',
  'race-paper': 'admin-03-race-paper.mp4',
  'win5-paper': 'admin-04-win5-paper.mp4',
  'assessment': 'admin-05-assessment.mp4',
  'free-report': 'admin-06-free-report.mp4',
  'publication-schedule': 'admin-07-publication-schedule.mp4',
  'results': 'admin-08-results.mp4',
  'social-share': 'admin-09-social-share.mp4',
  'notifications': 'admin-10-notifications.mp4',
  'incidents': 'admin-11-incidents.mp4'
} as const;

export function parseVideoRange(range: string | undefined, size: number) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return undefined;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return undefined;
  return { start, end };
}

@Controller('admin/manuals')
export class ManualsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get(':manualId/video')
  async video(@Req() req: AppRequest, @Res() res: Response, @Param('manualId') manualId: string) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'OPERATOR'])) {
      throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理者向け動画マニュアルを閲覧する権限を確認してください。' });
    }
    const fileName = adminManualFiles[manualId as keyof typeof adminManualFiles];
    if (!fileName) throw new NotFoundException({ code: 'MANUAL_VIDEO_NOT_FOUND', message: '動画マニュアルが見つかりません。' });
    let data: Buffer;
    try { data = await readFile(resolve(__dirname, '..', 'manuals', fileName)); }
    catch { throw new NotFoundException({ code: 'MANUAL_VIDEO_NOT_FOUND', message: '動画マニュアルが見つかりません。' }); }
    const range = parseVideoRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, data.length);
    if (range === undefined) {
      res.status(416).setHeader('Content-Range', `bytes */${data.length}`).end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? data.length - 1;
    const body = data.subarray(start, end + 1);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
    res.status(range ? 206 : 200).end(body);
  }
}
