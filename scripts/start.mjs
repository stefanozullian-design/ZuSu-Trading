#!/usr/bin/env node
/**
 * Starts ZuSu from a double-click, with no command to type.
 *
 * `npm run dev` assumes a person who knows to build the shared package after a
 * pull, to apply a migration that arrived with it, to notice which half failed,
 * and to open the right URL afterwards. Every one of those has stranded this
 * deployment at least once. This script does them in order, says which step it
 * is on in plain words, and stops on the first failure with an explanation
 * rather than a stack trace.
 *
 * It is deliberately a supervisor and not a daemon: the window it runs in is
 * where errors appear and closing it stops ZuSu. A background service that
 * fails silently would be worse for a single-user desktop install, because the
 * first sign of trouble would be a page that does not load.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  killTree,
  loadEnvFor,
  npmCommandLine,
  spawnOptions,
  supervisedOptions,
} from './env-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The web client's port is fixed in `apps/web/vite.config.ts` with
 * `strictPort` left off, so Vite would happily move to 5174 if 5173 were busy
 * — and the browser this script opens would then land on nothing. A unit test
 * asserts this constant and the Vite config still agree.
 */
export const WEB_PORT = 5173;

export function apiPort(env) {
  const value = Number(env.PORT);
  // An unreadable PORT is not an argument for guessing: the API's own default
  // is 4000, and matching it is the only answer that cannot be wrong twice.
  return Number.isInteger(value) && value > 0 ? value : 4000;
}

export function webUrl() {
  return `http://localhost:${String(WEB_PORT)}`;
}

export function apiHealthUrl(env) {
  return `http://127.0.0.1:${String(apiPort(env))}/api/system/live`;
}

/**
 * Turns a failure into something a person can act on.
 *
 * The underlying messages are accurate and useless: "P1000" and "ECONNREFUSED"
 * name the fault precisely to somebody who already knows what they mean. This
 * keeps the original text — never replaces it — and adds the sentence that
 * says what to do.
 */
export function adviceFor(message) {
  const text = String(message);
  if (/ECONNREFUSED|ENOTFOUND|Can't reach database|could not connect/i.test(text)) {
    return [
      'PostgreSQL does not appear to be running.',
      '',
      'On Windows: press the Start key, type "Services", find "postgresql-x64-16"',
      'and start it. If it is already running, the port in DATABASE_URL may be wrong.',
    ].join('\n');
  }
  if (/P1000|authentication failed|password authentication/i.test(text)) {
    return [
      'PostgreSQL refused the password in your .env file.',
      '',
      'Open .env in Notepad and check the DATABASE_URL line. The password there',
      'must be the one you chose when you installed PostgreSQL.',
    ].join('\n');
  }
  if (/P1003|does not exist|role .* does not exist/i.test(text)) {
    return [
      'The database or the user in DATABASE_URL does not exist.',
      '',
      'A stock PostgreSQL install has a user called "postgres" and no "zusu".',
      'Check the DATABASE_URL line in .env.',
    ].join('\n');
  }
  if (/P3009|failed migrations in the target database/i.test(text)) {
    return [
      'A previous update to the database was interrupted part-way through,',
      'and PostgreSQL will not apply any more until somebody looks at it.',
      '',
      'This needs a terminal once: open one in this folder and run',
      '  npm run db:deploy',
      'to see which update failed. Nothing has been lost — ZuSu refuses to run',
      'on a half-updated database rather than guess what the missing half did.',
    ].join('\n');
  }
  if (/EADDRINUSE/i.test(text)) {
    return [
      'Something is already using one of ZuSu’s ports.',
      '',
      'Most likely ZuSu is already running in another window. Close that window',
      'and try again.',
    ].join('\n');
  }
  return null;
}

// --- everything below this line only runs when the script is executed --------

/** Is something already answering on the web port? */
async function answering(url, timeoutMs = 1_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answering(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function openBrowser(url) {
  // Each platform's own "open whatever is registered for this" command. The
  // URL is a literal built from a port number, so nothing a person typed ever
  // reaches a command line.
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  // A failed spawn arrives as an 'error' *event*, not as a thrown exception,
  // so a try/catch here catches nothing and the unhandled event takes the
  // whole launcher down with it — the one failure a launcher must never have.
  // Found by running this on a machine with no xdg-open.
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // Not being able to open a browser is not a reason to stop: the URL is
      // printed either way and the person can click it.
    });
    child.unref();
  } catch {
    /* the same reasoning, for the synchronous case */
  }
}

function step(label, args, env) {
  process.stdout.write(`  ${label}\n`);
  const result = spawnSync(
    npmCommandLine(args),
    spawnOptions({ cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] }),
  );
  if (result.error) throw new Error(`could not run npm: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`${label} failed.\n\n${detail}`);
  }
}

/**
 * Says whether newer code exists, without ever getting in the way.
 *
 * Deliberately not an offer to install it: starting the app and changing the
 * code it runs are different acts, and one should not happen because somebody
 * wanted the other.
 */
function reportUpdates() {
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.status !== 0) return; // Not a clone. Nothing to compare against.

  const name = (branch.stdout ?? '').trim();
  if (git(['fetch', 'origin', name]).status !== 0) return; // Offline. Fine.

  const behind = git(['rev-list', '--count', `HEAD..origin/${name}`]);
  const count = Number((behind.stdout ?? '').trim());
  if (!Number.isInteger(count) || count <= 0) return;

  console.log(
    `  ─────────────────────────────────────────────────────────\n` +
      `  A newer ZuSu is available (${String(count)} change${count === 1 ? '' : 's'}).\n` +
      `  Close this window and double-click "Update ZuSu" to get it.\n` +
      `  ─────────────────────────────────────────────────────────\n`,
  );
}

async function main() {
  const env = loadEnvFor(root, process.env);

  console.log('\n  ZuSu Trading\n');

  if (!existsSync(join(root, '.env'))) {
    throw new Error(
      'This copy of ZuSu has not been set up yet.\n\n' +
        'There is no .env file, which is where the database password and the\n' +
        'security keys live. Run the one-time setup first: open a terminal in\n' +
        'this folder and run  npm run setup',
    );
  }

  // Double-clicking the icon twice should not produce a second, competing
  // copy — it should do what the person meant, which is "show me ZuSu".
  if (await answering(webUrl())) {
    console.log('  ZuSu is already running. Opening it.\n');
    openBrowser(webUrl());
    return;
  }

  // Both of these are no-ops when nothing has changed, and both are the step
  // that gets forgotten after a `git pull`: a stale shared package fails at
  // import time, and an unapplied migration fails at the first request with a
  // 500 that says nothing.
  step('Checking the shared code is up to date…', ['run', 'build', '-w', '@zusu/shared'], env);
  step('Checking the database is up to date…', ['run', 'db:deploy'], env);

  console.log('  Starting…\n');

  const children = [];
  let stopping = false;

  const stopAll = (code) => {
    if (stopping) return;
    stopping = true;
    // killTree, not kill: these are shells running npm running tsx and vite,
    // and stopping only the shell leaves the ports bound after the window has
    // closed.
    for (const child of children) killTree(child);
    process.exitCode = code ?? 0;
  };

  const start = (name, args) => {
    const child = spawn(
      npmCommandLine(args),
      // Both streams inherited: the API logs to stdout, so silencing it would
      // hide the one explanation available when it fails to start.
      supervisedOptions({ cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] }),
    );
    child.on('error', (error) => {
      console.error(`\n  ${name} could not start: ${error.message}`);
      stopAll(1);
    });
    // A half that dies leaves a page that loads with nothing behind it, which
    // looks like it worked. Stop both.
    child.on('exit', (code) => {
      if (!stopping) {
        console.error(`\n  ${name} stopped (exit ${String(code)}). Stopping ZuSu.`);
        stopAll(code ?? 1);
      }
    });
    children.push(child);
  };

  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  start('The engine', ['run', 'dev', '-w', '@zusu/api']);
  start('The screen', ['run', 'dev', '-w', '@zusu/web']);

  // Both halves, each on its own clock. Vite is ready in a second or two and
  // the API takes longer — it compiles, connects to the database and starts a
  // scheduler — so a single probe taken the moment the screen is up always
  // finds the engine missing and tells the person to reload a page that was
  // about to be fine.
  const [webUp, apiUp] = await Promise.all([
    waitUntilUp(webUrl(), 90_000),
    waitUntilUp(apiHealthUrl(env), 90_000),
  ]);

  if (!webUp) {
    // Not an error thrown at the person: the logs above are the evidence, and
    // one of the two halves has usually already said why.
    console.error(
      '\n  ZuSu did not finish starting within 90 seconds.\n' +
        '  The messages above say what it was doing when it stopped.\n',
    );
    return;
  }

  if (!apiUp) {
    // The screen on its own is a page that loads and then fails every request.
    console.log(
      '\n  The screen is up but the engine never answered.\n' +
        '  The messages above say why. ZuSu will not work until it does.\n',
    );
  }

  console.log(`\n  ZuSu is running at ${webUrl()}\n`);
  console.log('  Sign in with   manager@zusu.local   DemoTrading2026!\n');
  console.log('  Leave this window open while you use ZuSu.');
  console.log('  Closing it stops ZuSu.\n');

  openBrowser(webUrl());

  // Last, and never blocking: a person looking at an old version has no way to
  // tell, and "I double-clicked the icon" is a reasonable thing to believe
  // updates something. Offline, or a slow remote, simply says nothing.
  reportUpdates();
}

// Only run when executed, so the pure helpers above can be imported by tests.
// `pathToFileURL` rather than a `file://` template: on Windows the path is
// `C:\\Users\\...`, which does not become a URL by prefixing a scheme, and the
// comparison would silently never match — leaving a launcher that exits
// without starting anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ZuSu could not start.\n\n  ${message.split('\n').join('\n  ')}\n`);
    const advice = adviceFor(message);
    if (advice) console.error(`  ${advice.split('\n').join('\n  ')}\n`);
    process.exitCode = 1;
  }
}
