import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) throw new Error('.env already exists; refusing to overwrite');
const password = randomBytes(24).toString('hex');
const key = randomBytes(32).toString('base64');
writeFileSync('.env', `LOCAL_DB_PASSWORD=${password}\nDATABASE_URL=postgresql://keiba:${password}@127.0.0.1:55432/keiba\nDIRECT_DATABASE_URL=postgresql://keiba:${password}@127.0.0.1:55432/keiba\nAUTH_PROVIDER=local\nLAUNCH_MODE=FULL\nAPP_BASE_URL=http://localhost:3000\nAPI_BASE_URL=http://127.0.0.1:4000\nAPI_PORT=4000\nENCRYPTION_KEY=${key}\nNOTIFICATION_TRANSPORT=test\nLINE_OAUTH_TRANSPORT=test\nBILLING_TRANSPORT=test\nMAIL_TRANSPORT=test\nAUTH_RATE_LIMIT=600\nLOCAL_RATE_LIMIT_MULTIPLIER=10\n`, { mode: 0o600 });
mkdirSync('.local', { recursive: true });
console.info('Local .env created with generated secrets. No production credentials configured.');
