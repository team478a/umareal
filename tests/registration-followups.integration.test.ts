import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { account, base, Client, db } from './helpers';

beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Integration suite is limited to local authentication and database');
  if (!base.startsWith('http://127.0.0.1:')) throw new Error('API must be local');
});
afterAll(() => db.$disconnect());

describe('registration verification follow-up', () => {
  it('requires administrator MFA, lists overdue registrations and records a rate-limited resend', async () => {
    const admin = await account('ADMIN'); const client = new Client(); await client.login(admin);
    const pending = await account();
    await db.user.update({ where: { id: pending.user.id }, data: { emailVerifiedAt: null, createdAt: new Date('1990-01-01T00:00:00Z') } });

    expect((await client.call('admin/registration-followups')).status).toBe(403);
    await client.mfa();
    const list = await client.call('admin/registration-followups?status=OVERDUE');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ resendMode: 'ADMIN_DIRECT', selfServicePath: '/verify-email' });
    expect(list.body.items).toContainEqual(expect.objectContaining({ id: pending.user.id, email: pending.user.email, status: 'OVERDUE', canResend: true }));
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|passwordHash/);

    expect((await client.call(`admin/registration-followups/${pending.user.id}/resend`, 'POST', {})).status).toBe(400);
    const sent = await client.call(`admin/registration-followups/${pending.user.id}/resend`, 'POST', { reason: '会員から確認メール未着の連絡' });
    expect(sent.status).toBe(201);
    expect(sent.body.message).toBe('確認メールを再送しました。');
    const mail = JSON.parse(await readFile(resolve('.local/mail', `${pending.user.id}-verify.json`), 'utf8')) as { url: string; kind: string };
    expect(mail.kind).toBe('VERIFY_EMAIL');
    expect(await db.auditLog.count({ where: { actorId: admin.user.id, targetId: pending.user.id, action: 'ADMIN_EMAIL_VERIFICATION_RESEND', reason: '会員から確認メール未着の連絡' } })).toBe(1);
    const repeated = await client.call(`admin/registration-followups/${pending.user.id}/resend`, 'POST', { reason: '二重操作' });
    expect(repeated.status).toBe(409);
    expect(repeated.body.code).toBe('VERIFICATION_RESEND_COOLDOWN');

    const member = new Client(); const token = new URL(mail.url).searchParams.get('token');
    expect((await member.call('auth/email/verify', 'POST', { token })).status).toBe(201);
    const after = await client.call('admin/registration-followups');
    expect(after.body.items.map((item: { id: string }) => item.id)).not.toContain(pending.user.id);
  });
});
