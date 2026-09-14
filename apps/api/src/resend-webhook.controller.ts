import { BadRequestException, Controller, Inject, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Webhook } from 'svix';
import { loadMailConfig } from '@keiba/db';
import { AuthService } from './auth.service';

const handledEventTypes = ['email.bounced', 'email.complained', 'email.suppressed', 'email.failed', 'email.delivery_delayed'] as const;
const disablingReason = { 'email.bounced': 'BOUNCED', 'email.complained': 'COMPLAINED', 'email.suppressed': 'SUPPRESSED' } as const;
const eventSchema = z.object({
  type: z.string().min(1).max(100),
  created_at: z.string().datetime({ offset: true }),
  data: z.object({
    email_id: z.string().min(1).max(200),
    to: z.array(z.string().trim().email().max(254).transform(value => value.toLowerCase())).min(1).max(100)
  }).passthrough()
}).passthrough();

function header(req: Request, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Controller('webhooks/resend')
export class ResendWebhookController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post()
  async receive(@Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException({ code: 'RESEND_RAW_BODY_REQUIRED', message: 'Webhook本文を確認できません。' });
    const eventId = header(req, 'svix-id');
    const timestamp = header(req, 'svix-timestamp');
    const signature = header(req, 'svix-signature');
    if (!eventId || eventId.length > 200 || !timestamp || timestamp.length > 30 || !signature || signature.length > 1000) throw new UnauthorizedException({ code: 'RESEND_SIGNATURE_INVALID', message: 'Webhook署名を確認できません。' });
    const config = await loadMailConfig(this.auth.db);
    if (!config.webhookSecret) throw new ServiceUnavailableException({ code: 'RESEND_WEBHOOK_NOT_CONFIGURED', message: 'Resend Webhookは未設定です。' });
    try { new Webhook(config.webhookSecret).verify(rawBody, { 'svix-id': eventId, 'svix-timestamp': timestamp, 'svix-signature': signature }); }
    catch { throw new UnauthorizedException({ code: 'RESEND_SIGNATURE_INVALID', message: 'Webhook署名を確認できません。' }); }
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString('utf8')); }
    catch { throw new BadRequestException({ code: 'RESEND_WEBHOOK_INVALID_JSON', message: 'Webhook本文を処理できません。' }); }
    const body = eventSchema.parse(parsed);
    if (!handledEventTypes.includes(body.type as typeof handledEventTypes[number])) return { accepted: true, ignored: true };
    const eventType = body.type as typeof handledEventTypes[number];
    const recipients = [...new Set(body.data.to)].sort();
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`resend:${eventId}`}))::text`;
      if (await tx.emailWebhookEvent.findUnique({ where: { providerEventId: eventId }, select: { id: true } })) return { accepted: true, duplicate: true };
      const users = await tx.user.findMany({ where: { email: { in: recipients } }, orderBy: { id: 'asc' }, select: { id: true, emailDeliveryDisabledAt: true } });
      const reason = disablingReason[eventType as keyof typeof disablingReason];
      let disabledCount = 0;
      if (reason) {
        const now = new Date();
        for (const user of users) {
          if (!user.emailDeliveryDisabledAt) disabledCount += (await tx.user.updateMany({ where: { id: user.id, emailDeliveryDisabledAt: null }, data: { emailDeliveryDisabledAt: now, emailDeliveryDisabledReason: reason } })).count;
          await tx.notificationPreference.upsert({ where: { userId: user.id }, create: { userId: user.id, emailEnabled: false }, update: { emailEnabled: false } });
        }
      }
      const matchedCount = users.length;
      const outcome = matchedCount === 0 ? 'UNMATCHED'
        : matchedCount < recipients.length ? 'PARTIAL'
        : reason ? disabledCount > 0 ? 'DISABLED' : 'ALREADY_DISABLED'
        : 'MATCHED';
      await tx.emailWebhookEvent.create({ data: { providerEventId: eventId, providerEmailId: body.data.email_id, eventType, occurredAt: new Date(body.created_at), recipientCount: recipients.length, matchedCount, disabledCount, outcome } });
      return { accepted: true, duplicate: false, outcome, recipients: recipients.length, matched: matchedCount, disabled: disabledCount };
    }, { timeout: 10000, maxWait: 5000 });
  }
}
