import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import { config } from 'dotenv';

config({ quiet: true });

const workspace = resolve('.');
const localRoot = resolve(workspace, '.local');
const postgresRoot = resolve(localRoot, 'postgres');
const sourceData = resolve(postgresRoot, 'data');
const bin = resolve(postgresRoot, 'node_modules/@embedded-postgres/windows-x64/native/bin');
const backupsRoot = resolve(localRoot, 'backups');
const restoreRoot = resolve(localRoot, 'restore-verification');
const statusPath = resolve(backupsRoot, 'status.json');
const sourceUrl = new URL(process.env.DATABASE_URL ?? '');

if (process.platform !== 'win32' || process.env.AUTH_PROVIDER !== 'local' || process.env.NODE_ENV === 'production') throw new Error('Local Windows development only');
if (sourceUrl.protocol !== 'postgresql:' || sourceUrl.hostname !== '127.0.0.1' || sourceUrl.port !== '55432' || sourceUrl.pathname !== '/keiba') throw new Error('Expected isolated local database at 127.0.0.1:55432/keiba');
if (!existsSync(resolve(sourceData, 'PG_VERSION')) || !existsSync(resolve(bin, 'pg_ctl.exe'))) throw new Error('Local PostgreSQL is not initialized');

const backupId = `keiba-physical-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
if (!/^keiba-physical-\d{14}$/.test(backupId)) throw new Error('Invalid backup identifier');
const backupDir = resolve(backupsRoot, backupId);
const backupData = resolve(backupDir, 'data');
const restoreDir = resolve(restoreRoot, `${backupId}-restore`);
const restoreData = resolve(restoreDir, 'data');

function assertWithin(parent, target) {
  const rel = relative(parent, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.includes(`.${sep}..${sep}`)) throw new Error('Unsafe local path');
}

function runPgCtl(data, args, timeout = 60_000) {
  const result = spawnSync(resolve(bin, 'pg_ctl.exe'), ['-D', data, ...args], { encoding: 'utf8', windowsHide: true, timeout });
  if (result.status !== 0) throw new Error('PostgreSQL control command failed');
}

function isRunning(data) {
  return spawnSync(resolve(bin, 'pg_ctl.exe'), ['-D', data, 'status'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).status === 0;
}

function filesUnder(directory, current = directory) {
  return readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(current, entry.name);
    return entry.isDirectory() ? filesUnder(directory, path) : [path];
  }).sort((a, b) => relative(directory, a).localeCompare(relative(directory, b)));
}

function snapshotDigest(directory) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let fileCount = 0;
  for (const path of filesUnder(directory)) {
    const name = relative(directory, path).replaceAll('\\', '/');
    const data = readFileSync(path);
    hash.update(name); hash.update('\0'); hash.update(data); hash.update('\0');
    sizeBytes += data.byteLength; fileCount += 1;
  }
  return { sha256: hash.digest('hex'), sizeBytes, fileCount };
}

function safeStatus(value) {
  mkdirSync(backupsRoot, { recursive: true });
  const temporary = `${statusPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, statusPath);
}

const require = createRequire(resolve('packages/db/package.json'));
const { PrismaClient } = require('@prisma/client');
const expectedMigrations = readdirSync(resolve(workspace, 'packages/db/prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).length;

async function inspectDatabase(databaseUrl) {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const rows = await db.$queryRawUnsafe(`SELECT
      (SELECT count(*)::int FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations,
      (SELECT count(*)::int FROM "users") AS users,
      (SELECT count(*)::int FROM "races") AS races,
      (SELECT count(*)::int FROM "prediction_versions") AS "predictionVersions",
      (SELECT count(*)::int FROM "free_report_versions") AS "freeReportVersions",
      (SELECT count(*)::int FROM "audio_assets") AS "audioAssets",
      (SELECT count(*)::int FROM "publication_schedules") AS "publicationSchedules",
      (SELECT count(*)::int FROM "member_acquisitions") AS "memberAcquisitions",
      (SELECT count(*)::int FROM "acquisition_campaigns") AS "acquisitionCampaigns",
      (SELECT count(*)::int FROM "audit_logs") AS "auditLogs",
      (SELECT count(*)::int FROM "notification_events") AS "notificationEvents",
      (SELECT count(*)::int FROM "operational_alerts") AS "operationalAlerts",
      (SELECT count(*)::int FROM "operational_alert_deliveries") AS "operationalAlertDeliveries",
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('prediction_version_immutable','prediction_marks_immutable','prediction_bets_immutable','audit_no_update_delete','account_closure_no_update_delete','stripe_webhook_events_immutable','free_report_versions_no_update_delete','audio_assets_no_update_delete','member_acquisitions_no_update_delete')) AS "requiredTriggers"`);
    return rows[0];
  } finally {
    await db.$disconnect();
  }
}

let sourceStopped = false;
let restoreStarted = false;
let restoreRemoved = false;
let backupCreated = false;

try {
  assertWithin(backupsRoot, backupDir);
  assertWithin(restoreRoot, restoreDir);
  mkdirSync(backupsRoot, { recursive: true });
  mkdirSync(restoreRoot, { recursive: true });
  if (!isRunning(sourceData)) runPgCtl(sourceData, ['-l', resolve(postgresRoot, 'server.log'), '-w', 'start']);
  const sourceCounts = await inspectDatabase(sourceUrl.toString());
  if (sourceCounts.migrations !== expectedMigrations) throw new Error('Source migration count does not match the repository');

  runPgCtl(sourceData, ['-m', 'fast', '-w', 'stop']);
  sourceStopped = true;
  mkdirSync(backupDir, { recursive: false });
  cpSync(sourceData, backupData, { recursive: true, errorOnExist: true });
  backupCreated = true;
  const backup = snapshotDigest(backupData);
  writeFileSync(resolve(backupDir, 'manifest.json'), `${JSON.stringify({ format: 'postgresql-physical-directory', postgresMajor: 16, createdAt: new Date().toISOString(), ...backup }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  runPgCtl(sourceData, ['-l', resolve(postgresRoot, 'server.log'), '-w', 'start']);
  sourceStopped = false;

  mkdirSync(restoreDir, { recursive: false });
  cpSync(backupData, restoreData, { recursive: true, errorOnExist: true });
  const restoredCopy = snapshotDigest(restoreData);
  if (restoredCopy.sha256 !== backup.sha256 || restoredCopy.fileCount !== backup.fileCount || restoredCopy.sizeBytes !== backup.sizeBytes) throw new Error('Restored files do not match the backup manifest');

  runPgCtl(restoreData, ['-l', resolve(restoreDir, 'postgres.log'), '-o', '-p 55433 -c listen_addresses=127.0.0.1', '-w', 'start']);
  restoreStarted = true;
  const restoreUrl = new URL(sourceUrl); restoreUrl.port = '55433';
  const restoredCounts = await inspectDatabase(restoreUrl.toString());
  if (JSON.stringify(restoredCounts) !== JSON.stringify(sourceCounts)) throw new Error('Restored database integrity values do not match the source');
  if (restoredCounts.requiredTriggers !== 9) throw new Error('Required immutable-history triggers were not restored');

  runPgCtl(restoreData, ['-m', 'fast', '-w', 'stop']);
  restoreStarted = false;
  rmSync(restoreDir, { recursive: true, force: false });
  restoreRemoved = true;

  const verifiedAt = new Date().toISOString();
  safeStatus({ status: 'VERIFIED', verifiedAt, backupId, format: 'postgresql-physical-directory', postgresMajor: 16, encrypted: false, ...backup, migrations: restoredCounts.migrations, requiredTriggers: restoredCounts.requiredTriggers, restoredDatabaseRemoved: true, counts: { users: restoredCounts.users, races: restoredCounts.races, predictionVersions: restoredCounts.predictionVersions, freeReportVersions: restoredCounts.freeReportVersions, audioAssets: restoredCounts.audioAssets, publicationSchedules: restoredCounts.publicationSchedules, memberAcquisitions: restoredCounts.memberAcquisitions, acquisitionCampaigns: restoredCounts.acquisitionCampaigns, auditLogs: restoredCounts.auditLogs, notificationEvents: restoredCounts.notificationEvents, operationalAlerts: restoredCounts.operationalAlerts, operationalAlertDeliveries: restoredCounts.operationalAlertDeliveries } });
  console.info(`Backup ${backupId} verified and isolated restore data removed.`);
} catch {
  safeStatus({ status: 'FAILED', attemptedAt: new Date().toISOString(), errorCode: 'BACKUP_VERIFY_FAILED', backupId: backupCreated ? backupId : null, restoredDatabaseRemoved: restoreRemoved });
  console.error('Backup verification failed. See the local status file and server logs.');
  process.exitCode = 1;
} finally {
  if (restoreStarted && isRunning(restoreData)) {
    try { runPgCtl(restoreData, ['-m', 'fast', '-w', 'stop']); } catch { /* preserve the failure status */ }
  }
  if (existsSync(restoreDir) && !isRunning(restoreData)) {
    try { assertWithin(restoreRoot, restoreDir); rmSync(restoreDir, { recursive: true, force: false }); restoreRemoved = true; } catch { /* preserve for manual inspection */ }
  }
  if (sourceStopped || !isRunning(sourceData)) {
    try { runPgCtl(sourceData, ['-l', resolve(postgresRoot, 'server.log'), '-w', 'start']); } catch { console.error('Local source database could not be restarted.'); process.exitCode = 1; }
  }
}
