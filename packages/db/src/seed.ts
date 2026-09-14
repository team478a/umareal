import { PrismaClient } from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const db = new PrismaClient();
async function main() {
  if (process.env.AUTH_PROVIDER !== 'local' || process.env.NODE_ENV === 'production') throw new Error('Seed is local-only');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Seed requires a loopback database');
  const credentials: { email: string; password: string; role: string }[] = [];
  const accounts = [{ email: 'admin@example.test', displayName: '開発用 管理者', role: 'ADMIN' as const }, { email: 'expert@example.test', displayName: '開発用 専門家', role: 'EXPERT' as const }];
  for (const account of accounts) {
    if (await db.user.findUnique({ where: { email: account.email } })) continue;
    const password = randomBytes(18).toString('base64url'); const salt = randomBytes(16).toString('hex');
    await db.$transaction(async tx => {
      const user = await tx.user.create({ data: { ...account, emailVerifiedAt: new Date(), passwordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`, preferences: { create: {} } } });
      await tx.auditLog.create({ data: { actorId: user.id, actorRole: account.role, action: 'LOCAL_SEED', targetType: 'USER', targetId: user.id, reason: '開発専用の初期担当者作成', details: {}, requestId: crypto.randomUUID() } });
    });
    credentials.push({ email: account.email, password, role: account.role });
  }
  if (credentials.length) {
    const directory = resolve(process.cwd(), '../../.local'); await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'dev-accounts.json'), JSON.stringify(credentials, null, 2), { mode: 0o600 });
  }
  console.info(`Created ${credentials.length} local staff accounts. Credentials saved in .local/dev-accounts.json. MFA enrollment is required on first login.`);
}
main().finally(() => db.$disconnect());
