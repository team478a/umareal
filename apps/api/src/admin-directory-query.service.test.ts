import { describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import { AdminDirectoryQueryService } from './admin-directory-query.service';

const userId = '11111111-1111-4111-8111-111111111111';
const auditId = '22222222-2222-4222-8222-222222222222';

describe('AdminDirectoryQueryService', () => {
  it('returns the existing paginated member directory from a limited selection', async () => {
    const findMany = vi.fn().mockResolvedValue([{
      id: userId,
      email: 'member@example.test',
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      registrationMethod: 'EMAIL',
      lineAccount: null,
      displayName: '会員',
      role: 'MEMBER',
      createdAt: new Date('2026-10-01T01:00:00.000Z'),
    }]);
    const count = vi.fn().mockResolvedValue(1);
    const transaction = vi.fn(async values => Promise.all(values));
    const service = new AdminDirectoryQueryService({
      user: { findMany, count },
      $transaction: transaction,
    } as unknown as DbService);

    const result = await service.users(2, 10);

    expect(result).toEqual({
      items: [{
        id: userId,
        email: 'member@example.test',
        emailVerifiedAt: '2026-10-01T00:00:00.000Z',
        registrationMethod: 'EMAIL',
        lineAccount: null,
        displayName: '会員',
        role: 'MEMBER',
        createdAt: '2026-10-01T01:00:00.000Z',
      }],
      total: 1,
      page: 2,
      limit: 10,
    });
    expect(findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        registrationMethod: true,
        lineAccount: { select: { unlinkedAt: true } },
        displayName: true,
        role: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: 10,
      take: 10,
    });
    expect(result.items[0]).not.toHaveProperty('passwordHash');
    expect(result.items[0]).not.toHaveProperty('authSubject');
    expect(result.items[0]).not.toHaveProperty('mfaSecret');
  });

  it('preserves audit filters while never selecting private audit details', async () => {
    const auditFindMany = vi.fn().mockResolvedValue([{
      id: auditId,
      actorId: userId,
      actorRole: 'ADMIN',
      action: 'ENTITLEMENT_GRANT',
      targetType: 'USER',
      targetId: userId,
      reason: 'サポート対応',
      createdAt: new Date('2026-10-02T03:00:00.000Z'),
      requestId: 'request-1',
    }]);
    const auditCount = vi.fn().mockResolvedValue(1);
    const userFindMany = vi.fn().mockResolvedValue([{ id: userId, displayName: '管理者' }]);
    const transaction = vi.fn(async values => Promise.all(values));
    const service = new AdminDirectoryQueryService({
      auditLog: { findMany: auditFindMany, count: auditCount },
      user: { findMany: userFindMany },
      $transaction: transaction,
    } as unknown as DbService);

    const result = await service.audit({
      page: 2,
      limit: 20,
      from: '2026-10-01',
      to: '2026-10-02',
      action: 'grant',
      targetType: 'user',
      requestId: 'request-1',
    });

    const expectedWhere = {
      createdAt: {
        gte: new Date('2026-10-01T00:00:00+09:00'),
        lt: new Date('2026-10-03T00:00:00+09:00'),
      },
      action: { contains: 'grant', mode: 'insensitive' },
      targetType: { contains: 'user', mode: 'insensitive' },
      requestId: 'request-1',
    };
    expect(auditFindMany).toHaveBeenCalledWith({
      where: expectedWhere,
      select: {
        id: true,
        actorId: true,
        actorRole: true,
        action: true,
        targetType: true,
        targetId: true,
        reason: true,
        createdAt: true,
        requestId: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: 20,
      take: 20,
    });
    expect(auditCount).toHaveBeenCalledWith({ where: expectedWhere });
    expect(userFindMany).toHaveBeenCalledWith({
      where: { id: { in: [userId] } },
      select: { id: true, displayName: true },
    });
    expect(result.items[0]).toMatchObject({
      id: auditId,
      actorRole: 'ADMIN',
      actorDisplayName: '管理者',
      requestId: 'request-1',
    });
    expect(result.items[0]).not.toHaveProperty('actorId');
    expect(result.items[0]).not.toHaveProperty('details');
  });
});
