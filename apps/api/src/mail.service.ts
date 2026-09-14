import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMailConfig, Prisma } from '@keiba/db';
import { DbService } from './db.service';
import { hashToken, newToken } from './security';

type MailKind = 'VERIFY_EMAIL' | 'ADD_FALLBACK' | 'PASSWORD_RESET';

@Injectable()
export class MailService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async sendVerification(input: { userId: string; email: string; purpose: 'REGISTRATION' | 'ADD_FALLBACK'; passwordHash?: string }) {
    const token = newToken(); const expiresInMinutes = 30; const now = new Date();
    const verification = await this.db.$transaction(async tx => {
      await tx.emailVerification.updateMany({ where: { userId: input.userId, purpose: input.purpose, usedAt: null }, data: { usedAt: now } });
      return tx.emailVerification.create({ data: { userId: input.userId, tokenHash: hashToken(token), purpose: input.purpose, email: input.email, passwordHash: input.passwordHash, expiresAt: new Date(now.getTime() + expiresInMinutes * 60000) } });
    });
    await this.send({ userId: input.userId, to: input.email, kind: input.purpose === 'REGISTRATION' ? 'VERIFY_EMAIL' : 'ADD_FALLBACK', url: `${process.env.APP_BASE_URL}/verify-email?token=${token}`, expiresInMinutes, idempotencyKey: verification.id });
    return { sentAt: verification.createdAt, expiresAt: verification.expiresAt };
  }

  async resendRegistrationForAdmin(userId: string, minimumIntervalMs = 5 * 60000) {
    const token = newToken(); const expiresInMinutes = 30; const now = new Date();
    const result = await this.db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`);
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerifiedAt: true, disabledAt: true, registrationMethod: true } });
      if (!user || !user.email || user.registrationMethod !== 'EMAIL' || user.disabledAt) throw new NotFoundException({ code: 'REGISTRATION_FOLLOWUP_NOT_FOUND', message: '対象の確認待ち会員が見つかりません。' });
      if (user.emailVerifiedAt) throw new ConflictException({ code: 'EMAIL_ALREADY_VERIFIED', message: 'この会員はすでにメール確認済みです。' });
      const latest = await tx.emailVerification.findFirst({ where: { userId, purpose: 'REGISTRATION' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true } });
      if (latest && latest.createdAt.getTime() + minimumIntervalMs > now.getTime()) {
        throw new ConflictException({ code: 'VERIFICATION_RESEND_COOLDOWN', message: '直前に確認メールを送信しています。5分後に再度お試しください。', availableAt: new Date(latest.createdAt.getTime() + minimumIntervalMs).toISOString() });
      }
      await tx.emailVerification.updateMany({ where: { userId, purpose: 'REGISTRATION', usedAt: null }, data: { usedAt: now } });
      const verification = await tx.emailVerification.create({ data: { userId, tokenHash: hashToken(token), purpose: 'REGISTRATION', email: user.email, expiresAt: new Date(now.getTime() + expiresInMinutes * 60000) } });
      return { email: user.email, verification };
    });
    await this.send({ userId, to: result.email, kind: 'VERIFY_EMAIL', url: `${process.env.APP_BASE_URL}/verify-email?token=${token}`, expiresInMinutes, idempotencyKey: result.verification.id });
    return { sentAt: result.verification.createdAt, expiresAt: result.verification.expiresAt };
  }

  async send(input: { userId: string; to: string; kind: MailKind; url: string; expiresInMinutes: number; idempotencyKey: string }) {
    const transport = process.env.MAIL_TRANSPORT;
    if (transport === 'test') {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException({ code: 'MAIL_TRANSPORT_UNAVAILABLE', message: 'メールを送信できませんでした。' });
      const directory = resolve(process.cwd(), '../../.local/mail'); await mkdir(directory, { recursive: true });
      const suffix = input.kind === 'PASSWORD_RESET' ? '' : input.kind === 'VERIFY_EMAIL' ? '-verify' : '-fallback';
      await writeFile(resolve(directory, `${input.userId}${suffix}.json`), JSON.stringify({ to: input.to, url: input.url, expiresInMinutes: input.expiresInMinutes, kind: input.kind }), { mode: 0o600 });
      return;
    }
    if (transport !== 'resend') throw new ServiceUnavailableException({ code: 'MAIL_CONFIGURATION_INVALID', message: 'メールを送信できませんでした。' });
    const config = await loadMailConfig(this.db);
    if (!config.sendingComplete || !config.apiKey || !config.from) throw new ServiceUnavailableException({ code: 'MAIL_CONFIGURATION_INVALID', message: 'メールを送信できませんでした。' });
    const subject = input.kind === 'PASSWORD_RESET' ? 'パスワード再設定のご案内' : input.kind === 'ADD_FALLBACK' ? '予備メールアドレスの確認' : '無料会員登録の確認';
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey, 'User-Agent': 'keiba-member-media/1.0' }, body: JSON.stringify({ from: config.from, to: [input.to], subject, text: `${subject}\n\n以下のURLを開いてください。\n${input.url}\n\n有効期限は${input.expiresInMinutes}分です。心当たりがない場合は破棄してください。` }) });
    } catch { throw new ServiceUnavailableException({ code: 'MAIL_CONNECTION_FAILED', message: 'メールを送信できませんでした。時間をおいて再度お試しください。' }); }
    if (!response.ok) throw new ServiceUnavailableException({ code: 'MAIL_DELIVERY_FAILED', message: 'メールを送信できませんでした。時間をおいて再度お試しください。' });
  }
}
