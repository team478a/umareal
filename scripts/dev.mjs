import { spawn } from 'node:child_process';
import { config } from 'dotenv';
config({ quiet: true });
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = ['@keiba/api', '@keiba/web'].map(name => spawn(command, ['--filter', name, 'dev'], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const child of children) child.kill(); process.exit(0); });
for (const child of children) child.on('exit', code => { if (code) { for (const other of children) other.kill(); process.exit(code); } });
