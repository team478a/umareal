import { describe, expect, it } from 'vitest';
import { adminAuditQuerySchema, adminAuditResponseSchema } from './admin-audit';

const item = {
  id: '11111111-1111-4111-8111-111111111111', action: 'RACE_UPDATE', targetType: 'RACE', targetId: 'race-id',
  reason: '時刻訂正', actorRole: 'ADMIN', actorDisplayName: '管理者', createdAt: '2026-10-06T00:00:00.000Z', requestId: 'request-id'
};

describe('admin audit contract', () => {
  it('accepts bounded filters and rejects invalid ranges', () => {
    expect(adminAuditQuerySchema.parse({ from: '2026-10-01', to: '2026-10-06', action: ' RACE ' }).action).toBe('RACE');
    expect(adminAuditQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(adminAuditQuerySchema.safeParse({ from: '2026-10-07', to: '2026-10-06' }).success).toBe(false);
    expect(adminAuditQuerySchema.safeParse({ from: '2026-01-01', to: '2026-04-04' }).success).toBe(false);
    expect(adminAuditQuerySchema.safeParse({ action: 'x'.repeat(101) }).success).toBe(false);
  });

  it('keeps internal actor ids and audit details out of the response', () => {
    const response = { items: [item], total: 1, page: 1, limit: 20, filters: { from: null, to: null, action: null, targetType: null, requestId: null } };
    expect(adminAuditResponseSchema.parse(response)).toEqual(response);
    expect(adminAuditResponseSchema.safeParse({ ...response, items: [{ ...item, actorId: item.id }] }).success).toBe(false);
    expect(adminAuditResponseSchema.safeParse({ ...response, items: [{ ...item, details: { token: 'secret' } }] }).success).toBe(false);
  });
});
