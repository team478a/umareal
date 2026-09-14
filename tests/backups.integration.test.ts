import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('backup verification status', () => {
  it('is restricted to AAL2 administrators and exposes no database credentials', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/backups/status')).status).toBe(403);
    await admin.mfa();
    const response = await admin.call('admin/backups/status');
    expect(response.status).toBe(200);
    expect(['VERIFIED', 'FAILED', 'NOT_RUN', 'INVALID']).toContain(response.body.status);
    if (response.body.status === 'VERIFIED') {
      expect(response.body).toEqual(expect.objectContaining({ encrypted: false, restoredDatabaseRemoved: true }));
      expect(response.body.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(response.body.counts.users).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(response.body)).not.toMatch(/DATABASE_URL|password|55432|keiba@/i);

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/backups/status')).status).toBe(403);
    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/backups/status')).status).toBe(403);
  });
});
