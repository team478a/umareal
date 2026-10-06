import { ConflictException } from '@nestjs/common';
import { Prisma } from '@keiba/db';
import { describe, expect, it, vi } from 'vitest';
import { AdminEntitlementService, type ManualEntitlementGrant } from './admin-entitlement.service';
import type { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

const userId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const idempotencyHeader = '33333333-3333-4333-8333-333333333333';
const entitlementId = '44444444-4444-4444-8444-444444444444';
const req = { requestId: 'request-1', auth: { id: actorId, role: 'ADMIN', aal: 2 } } as AppRequest;
const input: ManualEntitlementGrant = {
  startsAt: '2026-10-07T00:00:00+09:00',
  endsAt: '2026-10-08T00:00:00+09:00',
  reason: '問い合わせ対応による有限期間付与',
  planCode: 'MANUAL',
};

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
}

function setup(transactionError?: Error, previous: { requestHash: string; response: unknown } | null = null) {
  const tx = {
    idempotencyKey: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    entitlement: { create: vi.fn().mockResolvedValue({ id: entitlementId }) },
  };
  const transaction = transactionError
    ? vi.fn().mockRejectedValue(transactionError)
    : vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
  const findUnique = vi.fn().mockResolvedValue(previous);
  const audit = vi.fn().mockResolvedValue({});
  const auth = { db: { $transaction: transaction, idempotencyKey: { findUnique } }, audit } as unknown as AuthService;
  return { service: new AdminEntitlementService(auth), tx, transaction, findUnique, audit };
}

describe('AdminEntitlementService', () => {
  it('creates one finite manual entitlement, audit record and replay response atomically', async () => {
    const { service, tx, audit } = setup();
    const key = `grant:${actorId}:${idempotencyHeader}`;
    const requestHash = hashToken(JSON.stringify({ userId, ...input }));

    await expect(service.grant(userId, actorId, input, idempotencyHeader, req)).resolves.toEqual({ id: entitlementId });

    expect(tx.idempotencyKey.create).toHaveBeenCalledWith({ data: { key, requestHash, response: {} } });
    expect(tx.entitlement.create).toHaveBeenCalledWith({ data: { ...input, userId, grantedBy: actorId } });
    expect(audit).toHaveBeenCalledWith(expect.anything(), req, 'ENTITLEMENT_GRANT', userId, input.reason, { entitlementId, ...input });
    expect(tx.idempotencyKey.update).toHaveBeenCalledWith({ where: { key }, data: { response: { id: entitlementId } } });
  });

  it('returns the stored response for an identical idempotent replay', async () => {
    const requestHash = hashToken(JSON.stringify({ userId, ...input }));
    const previous = { requestHash, response: { id: entitlementId } };
    const { service, findUnique } = setup(duplicateError(), previous);

    await expect(service.grant(userId, actorId, input, idempotencyHeader, req)).resolves.toEqual(previous.response);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: `grant:${actorId}:${idempotencyHeader}` } });
  });

  it('rejects an idempotency key reused with different content', async () => {
    const { service } = setup(duplicateError(), { requestHash: 'different', response: { id: entitlementId } });

    await expect(service.grant(userId, actorId, input, idempotencyHeader, req)).rejects.toMatchObject<ConflictException>({
      response: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('does not convert unrelated database errors into an idempotency conflict', async () => {
    const failure = new Error('database unavailable');
    const { service, findUnique } = setup(failure);

    await expect(service.grant(userId, actorId, input, idempotencyHeader, req)).rejects.toBe(failure);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
