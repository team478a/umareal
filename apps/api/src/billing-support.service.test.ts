import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import { BillingSupportService } from './billing-support.service';
import type { AppRequest } from './context';

const request = { requestId: 'request-1' } as AppRequest;
const createdAt = new Date('2027-10-01T00:00:00.000Z');
const updatedAt = new Date('2027-10-02T00:00:00.000Z');

function fixture(options: { previous?: { requestHash: string; response: unknown } | null; paymentUserId?: string | null; currentStatus?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | null } = {}) {
  const supportCreate = vi.fn().mockResolvedValue({ id: 'support-1', category: 'REFUND', status: 'OPEN', paymentTransactionId: 'payment-1', createdAt });
  const supportUpdate = vi.fn().mockResolvedValue({ id: 'support-1', status: 'IN_PROGRESS', updatedAt });
  const eventCreate = vi.fn().mockResolvedValue({ id: 'event-1' });
  const idempotencyCreate = vi.fn().mockResolvedValue({ key: 'support-key' });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    idempotencyKey: { findUnique: vi.fn().mockResolvedValue(options.previous ?? null), create: idempotencyCreate },
    paymentTransaction: { findUnique: vi.fn().mockResolvedValue(options.paymentUserId === null ? null : { userId: options.paymentUserId ?? 'user-1' }) },
    billingSupportRequest: {
      create: supportCreate,
      findUnique: vi.fn().mockResolvedValue(options.currentStatus === null ? null : { id: 'support-1', category: 'REFUND', status: options.currentStatus ?? 'OPEN' }),
      update: supportUpdate
    },
    billingSupportEvent: { create: eventCreate }
  };
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    idempotencyKey: { findUnique: vi.fn() }
  };
  const audit = vi.fn().mockResolvedValue(undefined);
  const service = new BillingSupportService({ db, audit } as unknown as AuthService);
  return { service, tx, audit, supportCreate, supportUpdate, eventCreate, idempotencyCreate };
}

describe('BillingSupportService', () => {
  it('creates a member support request with its immutable first event, idempotency record and audit log', async () => {
    const { service, tx, audit, supportCreate, idempotencyCreate } = fixture();

    await expect(service.create(request, 'user-1', { category: 'REFUND', paymentTransactionId: 'payment-1', message: '返金について確認したいです。' }, 'support-key', 'request-hash')).resolves.toEqual({
      id: 'support-1', category: 'REFUND', status: 'OPEN', paymentTransactionId: 'payment-1', createdAt: createdAt.toISOString()
    });
    expect(tx.paymentTransaction.findUnique).toHaveBeenCalledWith({ where: { id: 'payment-1' }, select: { userId: true } });
    expect(supportCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', category: 'REFUND', events: { create: expect.objectContaining({ eventType: 'CREATED', actorId: 'user-1', actorRole: 'MEMBER' }) } }) });
    expect(idempotencyCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ key: 'support-key', requestHash: 'request-hash' }) });
    expect(audit).toHaveBeenCalledWith(expect.anything(), request, 'BILLING_SUPPORT_REQUEST_CREATED', 'support-1', '会員本人による請求問い合わせ受付', { category: 'REFUND', paymentTransactionId: 'payment-1' });
  });

  it('returns a previous response without duplicating the request or its audit log', async () => {
    const response = { id: 'support-existing', status: 'OPEN' };
    const { service, tx, audit, supportCreate, idempotencyCreate } = fixture({ previous: { requestHash: 'request-hash', response } });

    await expect(service.create(request, 'user-1', { category: 'OTHER', message: '請求について確認したいです。' }, 'support-key', 'request-hash')).resolves.toEqual(response);
    expect(tx.paymentTransaction.findUnique).not.toHaveBeenCalled();
    expect(supportCreate).not.toHaveBeenCalled();
    expect(idempotencyCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects a payment that is not owned by the requesting member', async () => {
    const { service, supportCreate, audit } = fixture({ paymentUserId: 'user-2' });

    await expect(service.create(request, 'user-1', { category: 'RECEIPT', paymentTransactionId: 'payment-1', message: '領収書について確認したいです。' }, 'support-key', 'request-hash')).rejects.toMatchObject({ response: { code: 'PAYMENT_ACCESS_DENIED' } });
    expect(supportCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('updates support status with an append-only event and audit record', async () => {
    const { service, supportUpdate, eventCreate, audit } = fixture({ currentStatus: 'OPEN' });

    await expect(service.updateStatus(request, 'admin-1', 'support-1', { status: 'IN_PROGRESS', reason: '調査を開始します。' })).resolves.toEqual({ id: 'support-1', status: 'IN_PROGRESS', updatedAt });
    expect(supportUpdate).toHaveBeenCalledWith({ where: { id: 'support-1' }, data: { status: 'IN_PROGRESS', updatedAt: expect.any(Date) } });
    expect(eventCreate).toHaveBeenCalledWith({ data: { requestId: 'support-1', eventType: 'IN_PROGRESS', actorId: 'admin-1', actorRole: 'ADMIN', reason: '調査を開始します。' } });
    expect(audit).toHaveBeenCalledWith(expect.anything(), request, 'BILLING_SUPPORT_STATUS_CHANGED', 'support-1', '調査を開始します。', { category: 'REFUND', previousStatus: 'OPEN', status: 'IN_PROGRESS' });
  });

  it('rejects an invalid status transition before writing an event or audit record', async () => {
    const { service, supportUpdate, eventCreate, audit } = fixture({ currentStatus: 'IN_PROGRESS' });

    await expect(service.updateStatus(request, 'admin-1', 'support-1', { status: 'OPEN', reason: '状態を戻します。' })).rejects.toMatchObject({ response: { code: 'BILLING_SUPPORT_TRANSITION_INVALID' } });
    expect(supportUpdate).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
