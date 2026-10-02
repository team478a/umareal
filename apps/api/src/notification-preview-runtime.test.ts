import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsController } from './notifications.controller';

afterEach(() => vi.unstubAllEnvs());

describe('notification preview transport availability', () => {
  it.each([['line', true, true], ['test', true, true], ['disabled', true, false], ['line', false, false]])('counts only available LINE deliveries for %s / enabled=%s', async (transport, enabled, available) => {
    vi.stubEnv('LAUNCH_MODE', 'FREE_REGISTRATION');
    vi.stubEnv('NOTIFICATION_TRANSPORT', String(transport));
    vi.stubEnv('APP_BASE_URL', 'https://example.test');
    const settings = { lineNotificationsEnabled: enabled, emailNotificationsEnabled: true };
    const raceId = randomUUID();
    const auth = {
      authenticate: async () => ({ id: randomUUID(), role: 'ADMIN', aal: 2 }),
      db: {
        race: { findUnique: async () => ({ id: raceId, raceDate: '2096-01-01', venue: '東京', number: 9, name: '対象レース', status: 'SCHEDULED', startsAt: new Date('2096-01-01T06:00:00Z'), announcements: [] }) },
        systemSetting: { findUniqueOrThrow: async () => settings },
        user: { count: async () => 0 },
        $transaction: async () => [settings, 3, 4, 2]
      }
    };
    const result = await new NotificationsController(auth as never).previewRaceAnnouncement({} as never, { raceId });
    expect(result.audience).toMatchObject({
      line: { enabled: available, eligibleRecipients: 3, scheduledDeliveries: available ? 3 : 0 },
      email: { enabled: true, eligibleRecipients: 4, scheduledDeliveries: 4 },
      uniqueMembers: available ? 5 : 4, totalDeliveries: available ? 7 : 4, duplicateChannelMembers: available ? 2 : 0
    });
    expect(result.message.text).toContain(`/races/${raceId}`);
  });
});
