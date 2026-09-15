import 'reflect-metadata';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { databaseRuntimeAccessRestricted, loadMailConfig, Prisma } from '@keiba/db';
import { launchCapabilities, legalDocumentReleaseErrors, resolveLaunchMode } from '@keiba/domain';
import { AppController } from './app.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DbService } from './db.service';
import type { AppRequest } from './context';
import { RacesController } from './races.controller';
import { AssessmentsController } from './assessments.controller';
import { PredictionsController } from './predictions.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { NotificationsController } from './notifications.controller';
import { LineWebhookController } from './line-webhook.controller';
import { LineLoginController } from './line-login.controller';
import { LineLoginService } from './line-login.service';
import { ResultsController } from './results.controller';
import { BillingController } from './billing.controller';
import { MailService } from './mail.service';
import { MemberNotificationsController } from './member-notifications.controller';
import { AdminFreeReportsController, MemberFreeReportsController } from './free-reports.controller';
import { PublicationSchedulesController } from './publication-schedules.controller';
import { SupabaseAuthService } from './supabase-auth.service';
import { ResendWebhookController } from './resend-webhook.controller';
import { RegistrationFollowupsController } from './registration-followups.controller';
import { RegistrationCaptchaService } from './registration-captcha.service';
config({ path: resolve(process.cwd(), '../../.env'), quiet: true });

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<AppRequest>();
    let status = 500, code = 'INTERNAL_ERROR', message = '処理を完了できませんでした。時間をおいて再度お試しください。';
    let details: unknown = undefined;
    if (error instanceof ZodError) { status = 400; code = 'VALIDATION_ERROR'; message = '入力内容を確認してください。'; details = error.issues.map(i => ({ path: i.path.join('.'), message: i.message })); }
    else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') { status = 409; code = 'CONFLICT'; message = '登録内容が重複しています。'; }
    else if (error instanceof HttpException) {
      status = error.getStatus();
      const response = error.getResponse();
      const data = typeof response === 'object' ? response as { code?: string; message?: string } : {};
      code = data.code ?? ({ 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 400: 'BAD_REQUEST' }[status] ?? 'REQUEST_ERROR');
      message = data.message ?? (status === 401 ? 'ログインしてください。' : 'リクエストを処理できません。');
    }
    if (status === 500) console.error(JSON.stringify({ requestId: req.requestId, code, errorType: error instanceof Error ? error.name : 'UnknownError' }));
    res.status(status).json({ code, message, requestId: req.requestId, details });
  }
}
@Module({ controllers: [AuthController, AppController, RacesController, AssessmentsController, PredictionsController, AdminSettingsController, NotificationsController, MemberNotificationsController, AdminFreeReportsController, MemberFreeReportsController, PublicationSchedulesController, LineWebhookController, ResendWebhookController, RegistrationFollowupsController, LineLoginController, ResultsController, BillingController], providers: [DbService, AuthService, SupabaseAuthService, LineLoginService, MailService, RegistrationCaptchaService] })
class AppModule {}

async function main() {
  const provider = process.env.AUTH_PROVIDER;
  if (process.env.NODE_ENV === 'production' && !process.env.LAUNCH_MODE) throw new Error('Set LAUNCH_MODE explicitly in production');
  const launchMode = resolveLaunchMode(process.env.LAUNCH_MODE);
  const capabilities = launchCapabilities(launchMode);
  let applicationUrl: URL;
  try { applicationUrl = new URL(process.env.APP_BASE_URL ?? ''); } catch { throw new Error('APP_BASE_URL must be an absolute URL'); }
  if (process.env.NODE_ENV === 'production' && applicationUrl.protocol !== 'https:') throw new Error('Production requires an HTTPS application URL');
  if (!['local', 'supabase'].includes(provider ?? '')) throw new Error('Set AUTH_PROVIDER explicitly');
  if (provider === 'local' && process.env.NODE_ENV === 'production') throw new Error('Local authentication is forbidden in production');
  if (provider === 'supabase') {
    let supabaseUrl: URL;
    try { supabaseUrl = new URL(process.env.SUPABASE_URL ?? ''); } catch { throw new Error('Configure SUPABASE_URL'); }
    if (!process.env.SUPABASE_ANON_KEY) throw new Error('Configure SUPABASE_ANON_KEY');
    if (process.env.NODE_ENV === 'production' && supabaseUrl.protocol !== 'https:') throw new Error('Production requires an HTTPS Supabase URL');
  }
  if (Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64').length !== 32) throw new Error('Configure ENCRYPTION_KEY');
  if (process.env.CORRECTION_POLICY && !['ADMIN_ONLY', 'EXPERT_OR_ADMIN'].includes(process.env.CORRECTION_POLICY)) throw new Error('Invalid CORRECTION_POLICY');
  if (process.env.DELAYED_PUBLICATION_POLICY && !['CLOSED', 'LATEST_STARTS_AT'].includes(process.env.DELAYED_PUBLICATION_POLICY)) throw new Error('Invalid DELAYED_PUBLICATION_POLICY');
  if (!['test', 'line', 'disabled'].includes(process.env.NOTIFICATION_TRANSPORT ?? '')) throw new Error('Set NOTIFICATION_TRANSPORT explicitly');
  if (!['test', 'line', 'disabled'].includes(process.env.LINE_OAUTH_TRANSPORT ?? '')) throw new Error('Set LINE_OAUTH_TRANSPORT explicitly');
  if (process.env.NODE_ENV === 'production' && capabilities.lineNotifications && process.env.NOTIFICATION_TRANSPORT !== 'line') throw new Error('Full production launch requires the LINE notification transport');
  if (process.env.NODE_ENV === 'production' && capabilities.lineLogin && process.env.LINE_OAUTH_TRANSPORT !== 'line') throw new Error('Full production launch requires the LINE OAuth transport');
  if (process.env.NODE_ENV === 'production' && !capabilities.lineNotifications && process.env.NOTIFICATION_TRANSPORT !== 'disabled') throw new Error('Free registration launch requires LINE notifications to be disabled');
  if (process.env.NODE_ENV === 'production' && !capabilities.lineLogin && process.env.LINE_OAUTH_TRANSPORT !== 'disabled') throw new Error('Free registration launch requires LINE OAuth to be disabled');
  if (!['test', 'stripe', 'disabled'].includes(process.env.BILLING_TRANSPORT ?? '')) throw new Error('Set BILLING_TRANSPORT explicitly');
  if (process.env.NODE_ENV === 'production' && capabilities.billing && process.env.BILLING_TRANSPORT !== 'stripe') throw new Error('Full production launch requires an external billing transport');
  if (process.env.NODE_ENV === 'production' && capabilities.billing && process.env.STRIPE_LIVE_MODE !== 'true') throw new Error('Full production launch requires Stripe live mode');
  if (process.env.NODE_ENV === 'production' && !capabilities.billing && process.env.BILLING_TRANSPORT !== 'disabled') throw new Error('Free registration launch requires billing to be disabled');
  if (!['test', 'resend'].includes(process.env.MAIL_TRANSPORT ?? '')) throw new Error('Set MAIL_TRANSPORT explicitly');
  if (process.env.NODE_ENV === 'production' && process.env.MAIL_TRANSPORT !== 'resend') throw new Error('Production requires an external mail transport');
  if (!['test', 'turnstile'].includes(process.env.CAPTCHA_TRANSPORT ?? '')) throw new Error('Set CAPTCHA_TRANSPORT explicitly');
  if (process.env.NODE_ENV === 'production' && process.env.CAPTCHA_TRANSPORT !== 'turnstile') throw new Error('Production requires the Turnstile CAPTCHA transport');
  if (process.env.NODE_ENV === 'production') {
    const legalErrors = legalDocumentReleaseErrors();
    if (legalErrors.length) throw new Error(`Production requires published legal documents: ${legalErrors.join('; ')}`);
  }
  const authRateLimit = Number(process.env.AUTH_RATE_LIMIT ?? 60);
  if (!Number.isInteger(authRateLimit) || authRateLimit < 1 || authRateLimit > 1000 || (process.env.NODE_ENV === 'production' && authRateLimit > 60)) throw new Error('Invalid AUTH_RATE_LIMIT');
  const localRateMultiplier = provider === 'local' ? Number(process.env.LOCAL_RATE_LIMIT_MULTIPLIER ?? 1) : 1;
  if (!Number.isInteger(localRateMultiplier) || localRateMultiplier < 1 || localRateMultiplier > 10) throw new Error('Invalid LOCAL_RATE_LIMIT_MULTIPLIER');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], rawBody: true });
  if (process.env.NODE_ENV === 'production' && !await databaseRuntimeAccessRestricted(app.get(DbService))) {
    await app.close();
    throw new Error('Production requires a restricted database runtime role');
  }
  if (process.env.NODE_ENV === 'production' && !(await loadMailConfig(app.get(DbService))).complete) {
    await app.close();
    throw new Error('Production requires a complete admin or environment mail configuration');
  }
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  app.use((req: AppRequest, res: Response, next: () => void) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    const providerWebhook = req.method === 'POST' && ['/api/v1/webhooks/line', '/api/v1/webhooks/stripe', '/api/v1/webhooks/resend'].includes(req.originalUrl.split('?')[0]);
    if (!providerWebhook && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== process.env.APP_BASE_URL) {
      res.status(403).json({ code: 'ORIGIN_REJECTED', message: '許可されていない送信元です。', requestId: req.requestId }); return;
    }
    next();
  });
  const handler = (req: Request, res: Response) => { res.status(429).json({ code: 'RATE_LIMITED', message: 'しばらく待ってから再度お試しください。', requestId: (req as AppRequest).requestId }); };
  app.use('/api/v1/auth', rateLimit({ windowMs: 60000, limit: authRateLimit, standardHeaders: 'draft-8', legacyHeaders: false, handler }));
  app.use('/api/v1/webhooks/line', rateLimit({ windowMs: 60000, limit: 300 * localRateMultiplier, standardHeaders: 'draft-8', legacyHeaders: false, handler }));
  app.use('/api/v1/webhooks/stripe', rateLimit({ windowMs: 60000, limit: 300 * localRateMultiplier, standardHeaders: 'draft-8', legacyHeaders: false, handler }));
  app.use('/api/v1/webhooks/resend', rateLimit({ windowMs: 60000, limit: 300 * localRateMultiplier, standardHeaders: 'draft-8', legacyHeaders: false, handler }));
  app.use('/api/v1/admin', rateLimit({ windowMs: 60000, limit: 200 * localRateMultiplier, standardHeaders: 'draft-8', legacyHeaders: false, handler }));
  app.use('/api/v1/expert', rateLimit({ windowMs: 60000, limit: 300 * localRateMultiplier, standardHeaders: 'draft-8', legacyHeaders: false, handler }));
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API port');
  await app.listen(port, provider === 'local' ? '127.0.0.1' : '0.0.0.0');
  console.info(`API ready on port ${port}`);
}
void main();
