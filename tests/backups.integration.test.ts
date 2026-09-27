import { afterAll, describe, expect, it } from 'vitest';
import { adminBackupStatusResponseSchema } from '../packages/domain/src';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('backup verification status', () => {
  it('is restricted to AAL2 administrators and exposes no database credentials', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/backups/status')).status).toBe(403);
    await admin.mfa();
    const response = await admin.call('admin/backups/status');
    expect(response.status).toBe(200);
    const parsed = adminBackupStatusResponseSchema.parse(response.body);
    expect(['VERIFIED', 'FAILED', 'NOT_RUN', 'INVALID']).toContain(parsed.status);
    if (parsed.status === 'VERIFIED') {
      expect(parsed).toEqual(expect.objectContaining({ encrypted: false, restoredDatabaseRemoved: true }));
      expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.counts.users).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(parsed)).not.toMatch(/DATABASE_URL|password|55432|keiba@/i);
    expect(parsed).not.toHaveProperty('absolutePath');
    expect(parsed).not.toHaveProperty('log');

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/backups/status')).status).toBe(403);
    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/backups/status')).status).toBe(403);
  });
});
