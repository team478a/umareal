import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMailConfig } from '@keiba/db';
import { DbService } from './db.service';

type MailKind = 'VERIFY_EMAIL' | 'ADD_FALLBACK' | 'PASSWORD_RESET';

@Injectable()
export class MailService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

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
    if (!config.complete || !config.apiKey || !config.from) throw new ServiceUnavailableException({ code: 'MAIL_CONFIGURATION_INVALID', message: 'メールを送信できませんでした。' });
    const subject = input.kind === 'PASSWORD_RESET' ? 'パスワード再設定のご案内' : input.kind === 'ADD_FALLBACK' ? '予備メールアドレスの確認' : '無料会員登録の確認';
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey, 'User-Agent': 'keiba-member-media/1.0' }, body: JSON.stringify({ from: config.from, to: [input.to], subject, text: `${subject}\n\n以下のURLを開いてください。\n${input.url}\n\n有効期限は${input.expiresInMinutes}分です。心当たりがない場合は破棄してください。` }) });
    } catch { throw new ServiceUnavailableException({ code: 'MAIL_CONNECTION_FAILED', message: 'メールを送信できませんでした。時間をおいて再度お試しください。' }); }
    if (!response.ok) throw new ServiceUnavailableException({ code: 'MAIL_DELIVERY_FAILED', message: 'メールを送信できませんでした。時間をおいて再度お試しください。' });
  }
}
