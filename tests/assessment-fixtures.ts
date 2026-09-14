import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';
// Fixture sessions isolate assessment authorization tests from the separately tested login/TOTP workflow.
export async function assessmentFixture(role: 'EXPERT' | 'ADMIN' | 'MEMBER' = 'EXPERT', aal = 2, entryCount = 2) {
  if (process.env.AUTH_PROVIDER !== 'local' || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Local test database required');
  const owner = await account(role); const token = randomBytes(32).toString('base64url');
  await db.session.create({ data: { userId: owner.user.id, tokenHash: createHash('sha256').update(token).digest('hex'), aal, expiresAt: new Date(Date.now() + 3600000) } });
  const client = new Client(); client.cookie = `keiba_session=${token}`;
  const race = await db.race.create({ data: { raceDate: '2096-01-01', venue: `INPUT-${randomUUID().slice(0, 8)}`, number: 1, name: `評価試験-${randomUUID().slice(0, 6)}`, startsAt: new Date('2096-01-01T06:00:00Z'), assignments: { create: { userId: owner.user.id } } } });
  const entries = [];
  for (let number = 1; number <= entryCount; number++) entries.push(await db.raceEntry.create({ data: { race: { connect: { id: race.id } }, horse: { create: { id: randomUUID(), name: `評価試験馬${number}` } }, number, gate: Math.min(8, Math.ceil(number / 2)), horseName: `評価試験馬${number}`, sex: 'MALE', age: 3, carriedWeight: 57, jockey: '試験騎手', trainer: '試験調教師' } }));
  return { owner, client, race, entries, token };
}
