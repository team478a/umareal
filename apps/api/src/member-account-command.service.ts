import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  memberJourneyResponseSchema,
  notificationPreferencesResponseSchema,
  preferencesSchema,
  type MemberJourneyEvent,
  type MemberJourneyResponse,
  type NotificationPreferencesResponse,
} from '@keiba/domain';
import type { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

type NotificationPreferencesInput = z.infer<typeof preferencesSchema>;

@Injectable()
export class MemberAccountCommandService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async updatePreferences(userId: string, input: NotificationPreferencesInput, req: AppRequest): Promise<NotificationPreferencesResponse> {
    const result = await this.auth.db.$transaction(async tx => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { emailDeliveryDisabledAt: true } });
      if (input.emailEnabled && user.emailDeliveryDisabledAt) {
        throw new ConflictException({ code: 'EMAIL_DELIVERY_BLOCKED', message: '配信先で受信拒否が確認されたため、メール通知を再開できません。メールアドレスを変更してください。' });
      }
      const before = await tx.notificationPreference.findUnique({ where: { userId } });
      const next = await tx.notificationPreference.upsert({ where: { userId }, create: { userId, ...input }, update: input });
      await this.auth.audit(tx, req, 'PREFERENCES_UPDATE', userId, '通知設定の変更', { before, after: input });
      return {
        emailEnabled: next.emailEnabled,
        predictions: next.predictions,
        changes: next.changes,
        articles: next.articles,
        billing: next.billing,
      };
    });
    return notificationPreferencesResponseSchema.parse(result);
  }

  async recordJourney(userId: string, eventType: MemberJourneyEvent['eventType']): Promise<MemberJourneyResponse> {
    const event = await this.auth.db.$transaction(async tx => {
      await this.auth.journey(tx, userId, 'FIRST_LOGIN');
      return this.auth.journey(tx, userId, eventType);
    });
    return memberJourneyResponseSchema.parse({ ...event, recorded: true });
  }
}
