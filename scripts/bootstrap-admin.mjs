import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '../packages/db/dist/index.js';
import { config } from 'dotenv';

config({ path: '.env', quiet: true });

class BootstrapError extends Error {}

function input() {
  const subject = process.env.BOOTSTRAP_ADMIN_SUBJECT?.trim();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (process.env.AUTH_PROVIDER !== 'supabase') throw new BootstrapError('Initial administrator bootstrap requires AUTH_PROVIDER=supabase.');
  if (process.env.BOOTSTRAP_CONFIRM !== 'CREATE_FIRST_ADMIN') throw new BootstrapError('Set BOOTSTRAP_CONFIRM=CREATE_FIRST_ADMIN for this one-time operation.');
  if (!subject || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject)) throw new BootstrapError('Set BOOTSTRAP_ADMIN_SUBJECT to the registered Supabase user UUID.');
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BootstrapError('Set BOOTSTRAP_ADMIN_EMAIL to the registered email address.');
  return { subject, email };
}

const db = new PrismaClient();
try {
  const value = input();
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('umareal:first-admin-bootstrap'))`;
    if (await tx.user.count({ where: { role: 'ADMIN', disabledAt: null } })) throw new BootstrapError('An enabled administrator already exists; bootstrap was not applied.');
    const user = await tx.user.findUnique({ where: { authSubject: value.subject } });
    if (!user || user.email?.toLowerCase() !== value.email || !user.emailVerifiedAt || user.disabledAt || user.role !== 'MEMBER') throw new BootstrapError('The verified MEMBER does not exactly match the supplied subject and email.');
    const updated = await tx.user.updateMany({ where: { id: user.id, role: 'MEMBER', disabledAt: null, emailVerifiedAt: { not: null } }, data: { role: 'ADMIN' } });
    if (updated.count !== 1) throw new BootstrapError('The member changed during bootstrap; no administrator was created.');
    await tx.auditLog.create({ data: { actorId: user.id, actorRole: 'ADMIN', action: 'INITIAL_ADMIN_BOOTSTRAP', targetType: 'USER', targetId: user.id, reason: '初回管理者をSupabase本人確認済み会員から昇格', details: { method: 'one-time-cli', authSubjectMatched: true, emailMatched: true }, requestId: randomUUID() } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  console.info('Initial administrator bootstrap completed. Sign in and enroll MFA before using administration features.');
} catch (error) {
  console.error(error instanceof BootstrapError ? error.message : 'Initial administrator bootstrap failed.');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
