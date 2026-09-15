import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from './db.service';
import { decrypt } from './security';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TEST_REGISTRATION_CAPTCHA_TOKEN = 'test-registration-captcha';

const turnstileResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().max(253).optional(),
  action: z.string().max(32).optional()
}).passthrough();

export type RegistrationCaptchaTransport = 'test' | 'turnstile';

export function registrationCaptchaTransport(): RegistrationCaptchaTransport {
  return process.env.CAPTCHA_TRANSPORT === 'turnstile' ? 'turnstile' : 'test';
}

@Injectable()
export class RegistrationCaptchaService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async publicConfig() {
    const settings = await this.db.systemSetting.findUnique({
      where: { id: 'global' },
      select: { registrationCaptchaEnabled: true, turnstileSiteKey: true }
    });
    const enabled = settings?.registrationCaptchaEnabled === true;
    return {
      enabled,
      siteKey: enabled ? settings?.turnstileSiteKey ?? null : null,
      mode: registrationCaptchaTransport() === 'turnstile' ? 'TURNSTILE' as const : 'TEST_ONLY' as const
    };
  }

  async verify(token: string | undefined, requestId: string) {
    const settings = await this.db.systemSetting.findUnique({
      where: { id: 'global' },
      select: { registrationCaptchaEnabled: true, turnstileSecretEncrypted: true }
    });
    if (!settings?.registrationCaptchaEnabled) return;
    if (!token) throw new BadRequestException({ code: 'CAPTCHA_REQUIRED', message: '自動送信防止の確認を完了してください。' });

    const transport = registrationCaptchaTransport();
    if (transport === 'test') {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException({ code: 'CAPTCHA_CONFIGURATION_INVALID', message: '新規登録の保護設定を確認してください。' });
      if (token !== TEST_REGISTRATION_CAPTCHA_TOKEN) throw new BadRequestException({ code: 'CAPTCHA_INVALID', message: '自動送信防止の確認をやり直してください。' });
      return;
    }

    let secret: string;
    try {
      secret = settings.turnstileSecretEncrypted ? decrypt(settings.turnstileSecretEncrypted) : '';
    } catch {
      throw new ServiceUnavailableException({ code: 'CAPTCHA_CONFIGURATION_INVALID', message: '新規登録の保護設定を確認してください。' });
    }
    if (!secret) throw new ServiceUnavailableException({ code: 'CAPTCHA_CONFIGURATION_INVALID', message: '新規登録の保護設定を確認してください。' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token, idempotency_key: requestId }),
        signal: controller.signal
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'CAPTCHA_UNAVAILABLE', message: '自動送信防止の確認に接続できません。時間をおいて再度お試しください。' });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new ServiceUnavailableException({ code: 'CAPTCHA_UNAVAILABLE', message: '自動送信防止の確認に接続できません。時間をおいて再度お試しください。' });

    let parsed: z.infer<typeof turnstileResponseSchema>;
    try {
      parsed = turnstileResponseSchema.parse(await response.json());
    } catch {
      throw new ServiceUnavailableException({ code: 'CAPTCHA_UNAVAILABLE', message: '自動送信防止の確認に接続できません。時間をおいて再度お試しください。' });
    }
    let expectedHostname = '';
    try { expectedHostname = new URL(process.env.APP_BASE_URL ?? '').hostname; } catch { /* startup validation reports the invalid URL */ }
    if (!parsed.success || parsed.action !== 'register' || !expectedHostname || parsed.hostname !== expectedHostname) {
      throw new BadRequestException({ code: 'CAPTCHA_INVALID', message: '自動送信防止の確認をやり直してください。' });
    }
  }
}
