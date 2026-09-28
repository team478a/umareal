import { Inject, Injectable } from '@nestjs/common';
import { currentAccountResponseSchema, requiresMfa } from '@keiba/domain';
import type { Identity } from '@keiba/domain';
import { DbService } from './db.service';

@Injectable()
export class MemberAccountQueryService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async current(identity: Identity) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: identity.id },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        passwordHash: true,
        authSubject: true,
        registrationMethod: true,
        displayName: true,
        role: true,
        mfaSecret: true,
        externalMfaFactorId: true,
        externalBackupMfaFactorId: true,
        emailDeliveryDisabledAt: true,
        emailDeliveryDisabledReason: true,
        preferences: {
          select: { emailEnabled: true, predictions: true, changes: true, articles: true, billing: true },
        },
        lineAccount: {
          select: { unlinkedAt: true, notificationDisabledAt: true },
        },
        entitlements: {
          where: { revokedAt: null, endsAt: { gt: new Date() } },
          select: { planCode: true, startsAt: true, endsAt: true, raceDate: true },
        },
        consents: {
          orderBy: { acceptedAt: 'desc' },
          select: { documentType: true, version: true, acceptedAt: true },
        },
      },
    });
    const preferences = {
      emailEnabled: user.preferences?.emailEnabled ?? true,
      predictions: user.preferences?.predictions ?? true,
      changes: user.preferences?.changes ?? true,
      articles: user.preferences?.articles ?? false,
      billing: user.preferences?.billing ?? true,
    };
    const lineNotificationState = !user.lineAccount || user.lineAccount.unlinkedAt
      ? 'NOT_LINKED'
      : user.lineAccount.notificationDisabledAt
        ? 'BLOCKED'
        : !preferences.predictions
          ? 'DISABLED'
          : 'READY';
    const emailNotificationState = user.emailDeliveryDisabledAt
      ? 'BLOCKED'
      : !user.emailVerifiedAt
        ? 'UNVERIFIED'
        : !preferences.emailEnabled
          ? 'DISABLED'
          : 'READY';

    return currentAccountResponseSchema.parse({
      id: user.id,
      email: user.email,
      emailVerified: !!user.emailVerifiedAt,
      hasPassword: !!user.passwordHash || (process.env.AUTH_PROVIDER === 'supabase' && !!user.authSubject),
      registrationMethod: user.registrationMethod,
      displayName: user.displayName,
      role: user.role,
      aal: identity.aal,
      mfaEnabled: !!user.mfaSecret || !!user.externalMfaFactorId || identity.aal === 2,
      mfaBackupEnabled: !!user.externalBackupMfaFactorId,
      mfaBackupSupported: process.env.AUTH_PROVIDER === 'supabase' && user.role === 'ADMIN',
      mfaRequired: requiresMfa(user.role),
      preferences,
      lineLinked: !!user.lineAccount && !user.lineAccount.unlinkedAt,
      lineNotificationState,
      lineNotificationReady: lineNotificationState === 'READY',
      emailNotificationState,
      emailNotificationReady: emailNotificationState === 'READY',
      emailDeliveryDisabledAt: user.emailDeliveryDisabledAt,
      emailDeliveryDisabledReason: user.emailDeliveryDisabledReason,
      entitlements: user.entitlements,
      consents: user.consents,
    });
  }
}
