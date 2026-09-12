#!/usr/bin/env node
/**
 * One command from a fresh clone to a running demo.
 *
 * The README's step list is correct, but it has a fiddly middle — three
 * `openssl rand` calls pasted into a file by hand — and getting one of them
 * wrong fails much later with an error that does not name the cause. This
 * script does the whole sequence, and generates the secrets itself when `.env`
 * does not exist yet.
 *
 * It refuses to touch an existing `.env`. Overwriting one would be a way to
 * destroy real credentials with a convenience script, and no amount of
 * convenience is worth that.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');

function run(label, command, args) {
  process.stdout.write(`\n▶ ${label}\n`);
  // Every db:*/seed script routes through with-env.mjs, so `.env` is loaded
  // for the child even though nothing in this repository reads it implicitly.
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function writeEnv() {
  if (existsSync(envPath)) {
    console.log('✔ .env already exists — left exactly as it is.');
    return;
  }

  const example = join(root, '.env.example');
  if (!existsSync(example)) throw new Error('.env.example is missing; cannot bootstrap .env');
  copyFileSync(example, envPath);

  // The three secrets the API refuses to start without. Generated here so
  // nobody has to paste openssl output into the right three lines.
  const secrets = {
    JWT_SECRET: randomBytes(48).toString('base64'),
    COOKIE_SECRET: randomBytes(48).toString('base64'),
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };

  let contents = readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(secrets)) {
    const line = `${key}=${value}`;
    contents = new RegExp(`^${key}=.*$`, 'm').test(contents)
      ? contents.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${contents.trimEnd()}\n${line}\n`;
  }
  writeFileSync(envPath, contents, 'utf8');
  console.log('✔ wrote .env with freshly generated secrets.');
}

writeEnv();

run('Building the shared package', 'npm', ['run', 'build', '-w', '@zusu/shared']);
run('Generating the Prisma client', 'npm', ['run', 'db:generate']);
run('Applying migrations', 'npm', ['run', 'db:deploy']);
run('Seeding demo users, portfolio, positions and strategies', 'npm', ['run', 'seed']);
run('Backfilling calendars, candles and example scans', 'npm', ['run', 'backfill:demo']);

console.log(`
Ready. Start it with:

  npm run dev

Then open http://localhost:5173 and sign in:

  manager@zusu.local   DemoTrading2026!   (can trade; no second factor)
  admin@zusu.local     DemoTrading2026!   (will ask you to enrol MFA first)

Everything is DEMO: synthetic prices, a simulated venue, ALLOW_LIVE_TRADING off.
`);
