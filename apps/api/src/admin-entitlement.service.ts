import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@keiba/db';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

export type ManualEntitlementGrant = {
  startsAt: string;
  endsAt: string;
  reason: string;
  planCode: 'MANUAL';
};

@Injectable()
export class AdminEntitlementService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async grant(userId: string, actorId: string, input: ManualEntitlementGrant, idempotencyHeader: string, req: AppRequest) {
    const key = `grant:${actorId}:${idempotencyHeader}`;
    const requestHash = hashToken(JSON.stringify({ userId, ...input }));
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.idempotencyKey.create({ data: { key, requestHash, response: {} } });
        const grant = await tx.entitlement.create({ data: { ...input, userId, grantedBy: actorId } });
        await this.auth.audit(tx, req, 'ENTITLEMENT_GRANT', userId, input.reason, { entitlementId: grant.id, ...input });
        const response = { id: grant.id };
        await tx.idempotencyKey.update({ where: { key }, data: { response } });
        return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (!previous || previous.requestHash !== requestHash) {
        throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じリクエストキーが異なる内容で使用されています。' });
      }
      return previous.response;
    }
  }
}
