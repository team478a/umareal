import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { MemberAccountCommandService } from './member-account-command.service';

const userId = '11111111-1111-4111-8111-111111111111';
const req = { requestId: 'request-1', auth: { id: userId, role: 'MEMBER' } } as AppRequest;
const input = { emailEnabled: false, predictions: true, changes: false, articles: true, billing: true };

function setup(overrides: { blockedAt?: Date | null } = {}) {
  const before = { userId, emailEnabled: true, predictions: true, changes: true, articles: false, billing: true };
  const next = { userId, ...input };
  const tx = {
    user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ emailDeliveryDisabledAt: overrides.blockedAt ?? null }) },
    notificationPreference: {
      findUnique: vi.fn().mockResolvedValue(before),
      upsert: vi.fn().mockResolvedValue(next),
    },
  };
  const audit = vi.fn().mockResolvedValue({});
  const journey = vi.fn();
  const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
  const auth = { db: { $transaction: transaction }, audit, journey } as unknown as AuthService;
  return { service: new MemberAccountCommandService(auth), tx, audit, journey, transaction, before };
}

describe('MemberAccountCommandService', () => {
  it('updates the existing five preferences and preserves the audit record', async () => {
    const { service, tx, audit, before } = setup();

    await expect(service.updatePreferences(userId, input, req)).resolves.toEqual(input);

    expect(tx.user.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: userId }, select: { emailDeliveryDisabledAt: true } });
    expect(tx.notificationPreference.findUnique).toHaveBeenCalledWith({ where: { userId } });
    expect(tx.notificationPreference.upsert).toHaveBeenCalledWith({ where: { userId }, create: { userId, ...input }, update: input });
    expect(audit).toHaveBeenCalledWith(expect.anything(), req, 'PREFERENCES_UPDATE', userId, '通知設定の変更', { before, after: input });
  });

  it('continues to reject email re-enablement after a delivery block', async () => {
    const { service, tx, audit } = setup({ blockedAt: new Date('2026-10-01T00:00:00.000Z') });

    const enabled = { ...input, emailEnabled: true };
    await expect(service.updatePreferences(userId, enabled, req)).rejects.toMatchObject<ConflictException>({
      response: { code: 'EMAIL_DELIVERY_BLOCKED' },
    });
    expect(tx.notificationPreference.upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('records first login before the requested journey event and returns the public response', async () => {
    const { service, journey, transaction } = setup();
    const occurredAt = new Date('2026-10-02T03:04:05.000Z');
    journey.mockResolvedValueOnce({ eventType: 'FIRST_LOGIN', occurredAt }).mockResolvedValueOnce({ eventType: 'PLAN_VIEWED', occurredAt });

    await expect(service.recordJourney(userId, 'PLAN_VIEWED')).resolves.toEqual({
      eventType: 'PLAN_VIEWED',
      occurredAt: occurredAt.toISOString(),
      recorded: true,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(journey).toHaveBeenNthCalledWith(1, expect.anything(), userId, 'FIRST_LOGIN');
    expect(journey).toHaveBeenNthCalledWith(2, expect.anything(), userId, 'PLAN_VIEWED');
  });
});
