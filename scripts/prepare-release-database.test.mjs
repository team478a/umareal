import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { prepareReleaseDatabase, validateReleaseDatabaseEnvironment } from './prepare-release-database.mjs';

const base = {
  DB_RELEASE_CONFIRM: 'APPLY_MIGRATIONS_AND_VERIFY_RUNTIME',
  DATABASE_ADMIN_URL: 'postgresql://migration-owner:owner-secret@db.internal:5432/umareal?sslmode=require',
  DATABASE_RUNTIME_URL: 'postgresql://runtime-user:runtime-secret@db.internal:5432/umareal?sslmode=require',
  npm_execpath: 'C:\\pnpm\\pnpm.cjs'
};

test('requires explicit confirmation and separated roles on the same database', () => {
  assert.throws(() => validateReleaseDatabaseEnvironment({ ...base, DB_RELEASE_CONFIRM: '' }), /DB_RELEASE_CONFIRM/);
  assert.throws(() => validateReleaseDatabaseEnvironment({
    ...base,
    DATABASE_RUNTIME_URL: 'postgresql://migration-owner:other@db.internal:5432/umareal'
  }), /roles must be different/);
  assert.throws(() => validateReleaseDatabaseEnvironment({
    ...base,
    DATABASE_RUNTIME_URL: 'postgresql://runtime-user:other@other-db.internal:5432/umareal'
  }), /same database host/);
});

test('applies migrations before runtime verification without leaking both credentials to either child', async () => {
  const calls = [];
  const messages = [];
  await prepareReleaseDatabase({
    env: base,
    cwd: 'C:\\workspace',
    execute: async specification => calls.push(specification),
    log: message => messages.push(message)
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(-3), ['--filter', '@keiba/db', 'migrate']);
  assert.equal(calls[0].env.DATABASE_URL, base.DATABASE_ADMIN_URL);
  assert.equal(calls[0].env.DATABASE_RUNTIME_URL, undefined);
  assert.equal(calls[0].env.DATABASE_ADMIN_URL, undefined);
  assert.deepEqual(calls[1].args.slice(-1), ['db:access:verify']);
  assert.equal(calls[1].env.DATABASE_URL, base.DATABASE_RUNTIME_URL);
  assert.equal(calls[1].env.DATABASE_RUNTIME_URL, base.DATABASE_RUNTIME_URL);
  assert.equal(calls[1].env.DATABASE_ADMIN_URL, undefined);
  assert.equal(calls[1].env.DB_RELEASE_CONFIRM, undefined);
  assert.equal(messages.length, 3);
});

test('does not run runtime verification after a migration failure', async () => {
  let calls = 0;
  await assert.rejects(() => prepareReleaseDatabase({
    env: base,
    execute: async () => {
      calls += 1;
      throw new Error('migration failed');
    },
    log: () => {}
  }), /migration failed/);
  assert.equal(calls, 1);
});

test('keeps production and staging services behind the manual database release gate', async () => {
  for (const blueprint of ['render.yaml', 'render.staging.yaml']) {
    const value = await readFile(new URL(`../${blueprint}`, import.meta.url), 'utf8');
    assert.equal(value.match(/autoDeployTrigger: off/g)?.length, 3);
    assert.doesNotMatch(value, /autoDeployTrigger: checksPass/);
    assert.doesNotMatch(value, /DATABASE_ADMIN_URL|DIRECT_DATABASE_URL/);
  }
});
