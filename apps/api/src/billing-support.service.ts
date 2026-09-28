import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { billingSupportEventType, billingSupportRequestSchema, billingSupportStatusSchema } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import type { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

type BillingSupportRequestInput = z.infer<typeof billingSupportRequestSchema>;
type BillingSupportStatusInput = z.infer<typeof billingSupportStatusSchema>;

@Injectable()
export class BillingSupportService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async create(req: AppRequest, userId: string, input: BillingSupportRequestInput, key: string, requestHash: string) {
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) {
          if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ受付キーが異なる内容で使われています。' });
          return previous.response;
        }
        if (input.paymentTransactionId) {
          const payment = await tx.paymentTransaction.findUnique({ where: { id: input.paymentTransactionId }, select: { userId: true } });
          if (!payment || payment.userId !== userId) throw new ForbiddenException({ code: 'PAYMENT_ACCESS_DENIED', message: '対象の支払いを確認できません。' });
        }
        const support = await tx.billingSupportRequest.create({ data: { userId, paymentTransactionId: input.paymentTransactionId ?? null, category: input.category, message: input.message, events: { create: { eventType: 'CREATED', actorId: userId, actorRole: 'MEMBER', reason: input.message } } } });
        const response = { id: support.id, category: support.category, status: support.status, paymentTransactionId: support.paymentTransactionId, createdAt: support.createdAt.toISOString() };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } });
        await this.auth.audit(tx, req, 'BILLING_SUPPORT_REQUEST_CREATED', support.id, '会員本人による請求問い合わせ受付', { category: support.category, paymentTransactionId: support.paymentTransactionId });
        return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'BILLING_SUPPORT_CONFLICT', message: '受付状態が競合しました。再読み込みしてください。' });
    }
  }

  async updateStatus(req: AppRequest, actorId: string, id: string, input: BillingSupportStatusInput) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-support:${id}`}))::text`;
      const current = await tx.billingSupportRequest.findUnique({ where: { id } });
      if (!current) throw new NotFoundException({ code: 'BILLING_SUPPORT_NOT_FOUND', message: '問い合わせを確認できません。' });
      const eventType = billingSupportEventType(current.status, input.status);
      if (!eventType) throw new ConflictException({ code: 'BILLING_SUPPORT_TRANSITION_INVALID', message: '現在の状態から指定された状態へ変更できません。' });
      const updated = await tx.billingSupportRequest.update({ where: { id }, data: { status: input.status, updatedAt: new Date() } });
      await tx.billingSupportEvent.create({ data: { requestId: id, eventType, actorId, actorRole: 'ADMIN', reason: input.reason } });
      await this.auth.audit(tx, req, 'BILLING_SUPPORT_STATUS_CHANGED', id, input.reason, { category: current.category, previousStatus: current.status, status: input.status });
      return { id: updated.id, status: updated.status, updatedAt: updated.updatedAt };
    });
  }
}
