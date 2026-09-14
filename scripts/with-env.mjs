import { spawn } from 'node:child_process';
import { config } from 'dotenv';
config({ quiet: true });
const [command, ...args] = process.argv.slice(2);
if (!command || args.some(arg => /[;&|`\r\n]/.test(arg))) throw new Error('Invalid command');
const child = spawn(process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
child.on('exit', code => process.exit(code ?? 1));
