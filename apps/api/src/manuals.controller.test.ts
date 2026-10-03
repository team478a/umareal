import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { ManualsController, parseVideoRange } from './manuals.controller';

function response() {
  const value = { setHeader: vi.fn(), status: vi.fn(), end: vi.fn() };
  value.status.mockReturnValue(value);
  value.setHeader.mockReturnValue(value);
  return value;
}

describe('manual video range parsing', () => {
  it('supports explicit, open and suffix ranges', () => {
    expect(parseVideoRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseVideoRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseVideoRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('rejects invalid or out-of-bounds ranges', () => {
    expect(parseVideoRange('bytes=1000-', 1000)).toBeUndefined();
    expect(parseVideoRange('items=0-10', 1000)).toBeUndefined();
  });
});

describe('ManualsController', () => {
  it('rejects members before resolving a video', async () => {
    const authenticate = vi.fn().mockResolvedValue({ id: 'member', role: 'MEMBER', aal: 1 });
    const controller = new ManualsController({ authenticate } as unknown as AuthService);
    await expect(controller.video({ headers: {} } as AppRequest, response() as never, 'dashboard')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires AAL2 from an administrator', async () => {
    const authenticate = vi.fn().mockResolvedValue({ id: 'admin', role: 'ADMIN', aal: 1 });
    const controller = new ManualsController({ authenticate } as unknown as AuthService);
    await expect(controller.video({ headers: {} } as AppRequest, response() as never, 'dashboard')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not expose unknown video identifiers to authorized staff', async () => {
    const authenticate = vi.fn().mockResolvedValue({ id: 'operator', role: 'OPERATOR', aal: 1 });
    const controller = new ManualsController({ authenticate } as unknown as AuthService);
    await expect(controller.video({ headers: {} } as AppRequest, response() as never, '../secret')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('streams an allowlisted range to authorized staff', async () => {
    const authenticate = vi.fn().mockResolvedValue({ id: 'operator', role: 'OPERATOR', aal: 1 });
    const controller = new ManualsController({ authenticate } as unknown as AuthService);
    const res = response();
    await controller.video({ headers: { range: 'bytes=0-99' } } as AppRequest, res as never, 'dashboard');
    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'video/mp4');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.end).toHaveBeenCalledWith(expect.objectContaining({ length: 100 }));
  });
});
