#!/usr/bin/env node
/**
 * One command from a fresh clone to a running demo.
 *
 * The README's step list was correct and still stranded people. Two reasons,
 * both fixed here: nothing in this repository reads `.env` implicitly, and the
 * default `DATABASE_URL` assumes a `zusu` role that a stock PostgreSQL install
 * does not create. The Windows installer, for instance, makes a `postgres`
 * superuser with a password you choose — so the shipped default could never
 * have worked there.
 *
 * This script asks for those details once, writes them, and runs the rest. It
 * refuses to touch an existing `.env`: overwriting one would be a way to
 * destroy real credentials with a convenience script, and no amount of
 * convenience is worth that.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './env-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');

function run(label, args) {
  process.stdout.write(`\n▶ ${label}\n`);
  const result = spawnSync(npmCommand(), args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`could not run npm: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed. The output above says why; nothing after this ran.`);
  }
}

/** Percent-encodes a password so a `@`, `:` or `/` cannot break the URL. */
function encode(value) {
  return encodeURIComponent(value);
}

async function askForDatabaseUrl() {
  // Non-interactive (CI, a pipe): keep the documented default rather than
  // hanging on a prompt nobody can answer.
  if (!process.stdin.isTTY) return null;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`
Where is your PostgreSQL?

  Press Enter to accept each default. On a stock Windows or macOS install the
  user is "postgres" and the password is the one the installer asked you for.
  The database itself does not need to exist — it will be created.
`);
    const user = (await rl.question('  PostgreSQL user [postgres]: ')).trim() || 'postgres';
    const password = (await rl.question(`  Password for "${user}": `)).trim();
    const host = (await rl.question('  Host [localhost]: ')).trim() || 'localhost';
    const port = (await rl.question('  Port [5432]: ')).trim() || '5432';
    const database =
      (await rl.question('  Database name [zusu_trading]: ')).trim() || 'zusu_trading';

    return `postgresql://${encode(user)}:${encode(password)}@${host}:${port}/${database}?schema=public`;
  } finally {
    rl.close();
  }
}

function setKey(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.trimEnd()}\n${line}\n`;
}

async function writeEnv() {
  if (existsSync(envPath)) {
    console.log('✔ .env already exists — left exactly as it is.');
    return;
  }

  const example = join(root, '.env.example');
  if (!existsSync(example)) throw new Error('.env.example is missing; cannot bootstrap .env');
  copyFileSync(example, envPath);

  let contents = readFileSync(envPath, 'utf8');

  // The three secrets the API refuses to start without. Generated here so
  // nobody has to paste openssl output into the right three lines.
  contents = setKey(contents, 'JWT_SECRET', randomBytes(48).toString('base64'));
  contents = setKey(contents, 'COOKIE_SECRET', randomBytes(48).toString('base64'));
  contents = setKey(contents, 'CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'));

  const databaseUrl = await askForDatabaseUrl();
  if (databaseUrl) contents = setKey(contents, 'DATABASE_URL', databaseUrl);

  writeFileSync(envPath, contents, 'utf8');
  console.log('\n✔ wrote .env with freshly generated secrets.');
}

try {
  await writeEnv();

  run('Building the shared package', ['run', 'build', '-w', '@zusu/shared']);
  run('Generating the Prisma client', ['run', 'db:generate']);
  run('Creating the database and applying migrations', ['run', 'db:deploy']);
  run('Seeding demo users, portfolio, positions and strategies', ['run', 'seed']);
  run('Backfilling calendars, candles and example scans', ['run', 'backfill:demo']);
} catch (error) {
  console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}`);
  console.error(`
If that was a database error, check the DATABASE_URL line in .env:

  · "password authentication failed" — the password is wrong. Edit .env.
  · "ECONNREFUSED" — PostgreSQL is not running, or is on another port.
  · "role ... does not exist" — the user is wrong; a stock install uses "postgres".

Fix that line and run "npm run setup" again. It will keep the .env you have.
`);
  process.exit(1);
}

console.log(`
Ready. Start it with:

  npm run dev

Then open http://localhost:5173 and sign in:

  manager@zusu.local   DemoTrading2026!   (can trade; no second factor)
  admin@zusu.local     DemoTrading2026!   (will ask you to enrol MFA first)

Everything is DEMO: synthetic prices, a simulated venue, ALLOW_LIVE_TRADING off.
`);
