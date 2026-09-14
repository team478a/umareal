import { afterEach, describe, expect, it } from 'vitest';
import { BillingController } from './billing.controller';
import { LineLoginController } from './line-login.controller';
import { LineWebhookController } from './line-webhook.controller';
import type { AuthService } from './auth.service';
import type { LineLoginService } from './line-login.service';

const previousMode = process.env.LAUNCH_MODE;
afterEach(() => {
  if (previousMode === undefined) delete process.env.LAUNCH_MODE;
  else process.env.LAUNCH_MODE = previousMode;
});

describe('free registration launch API boundaries', () => {
  it('rejects billing mutations before authentication or provider access', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const controller = new BillingController({} as AuthService);
    await expect(controller.checkout({} as never, {})).rejects.toMatchObject({ response: { code: 'BILLING_NOT_IN_LAUNCH' } });
  });

  it('rejects LINE Login before creating an OAuth flow', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const controller = new LineLoginController({} as AuthService, {} as LineLoginService);
    await expect(controller.start({}, {} as never)).rejects.toMatchObject({ response: { code: 'LINE_LOGIN_NOT_IN_LAUNCH' } });
  });

  it('rejects LINE webhooks before reading credentials or request bodies', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const controller = new LineWebhookController({} as AuthService);
    await expect(controller.receive({} as never)).rejects.toMatchObject({ response: { code: 'LINE_WEBHOOK_NOT_IN_LAUNCH' } });
  });
});
