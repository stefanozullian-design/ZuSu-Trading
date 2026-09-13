#!/usr/bin/env node
/**
 * Fetches the newest ZuSu and makes it ready to run, from a double-click.
 *
 * The launcher deliberately does not do this. Starting the app and changing
 * the code it runs are different acts, and one of them should not happen
 * because somebody wanted the other — an update that arrives unannounced while
 * you are looking at positions is the wrong kind of surprise on a trading
 * tool. So updating is its own icon, run when you choose to.
 *
 * What it does, in order, stopping at the first failure with an explanation:
 * fetches, refuses to trample local edits, pulls, installs any new
 * dependencies, rebuilds the shared code, and applies any migration that came
 * with it. Nothing here touches .env or the database's contents.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFor, npmCommandLine, spawnOptions } from './env-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Written before the steps that follow a pull, removed when they finish.
 *
 * An update that pulls and then fails leaves a checkout whose code is new and
 * whose build is old. Without this the next run would see "already up to date"
 * and return, so the half-finished state could never be completed by the tool
 * that created it.
 */
const UNFINISHED = join(root, 'node_modules', '.zusu-update-unfinished');

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw new Error(`could not run git: ${result.error.message}`);
  return {
    status: result.status ?? 1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}

function npm(label, args, env) {
  process.stdout.write(`  ${label}\n`);
  const result = spawnSync(
    npmCommandLine(args),
    spawnOptions({ cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] }),
  );
  if (result.error) throw new Error(`could not run npm: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${label} failed.\n\n${String(result.stderr ?? '').trim()}`);
}

/**
 * Files nobody edits by hand, which tools rewrite as a side effect.
 *
 * `npm install` rewrites the lockfile on some machines — a different npm
 * version, a different set of platform-specific optional packages — and it is
 * generated from package.json rather than authored. Counted as a local edit it
 * created a deadlock nobody could escape: the update ran npm install, npm
 * rewrote the lockfile, and the next update refused because of a file the
 * previous update had modified. Forever.
 */
const GENERATED = ['package-lock.json'];

/** Splits a porcelain listing into what a person wrote and what a tool wrote. */
export function classifyEdits(porcelain) {
  const files = porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Untracked files are not in the way of a pull; modified tracked ones are.
    .filter((line) => !line.startsWith('??'))
    .map((line) => line.slice(2).trim());

  return {
    generated: files.filter((file) => GENERATED.includes(file)),
    authored: files.filter((file) => !GENERATED.includes(file)),
  };
}

/** Files the person changed themselves, which a pull would overwrite. */
export function localEdits(porcelain) {
  return classifyEdits(porcelain).authored;
}

/**
 * Explains a failure a person can do something about.
 *
 * The one that matters on Windows: a file cannot be replaced while a process
 * holds it open, so rebuilding the database client fails with EPERM on a
 * rename — a message about a temporary filename, for a situation whose whole
 * cause is that ZuSu is still running.
 */
export function adviceForUpdate(message) {
  const text = String(message);
  if (/EPERM|EBUSY|operation not permitted|resource busy/i.test(text)) {
    return [
      'ZuSu looks like it is still running.',
      '',
      'Windows will not let a file be replaced while a program has it open, and',
      'that is what stops the database client being rebuilt.',
      '',
      'Close the ZuSu window, then start ZuSu again — it finishes the update by',
      'itself. Or run this update once more with ZuSu closed.',
    ].join('\n');
  }
  return null;
}

async function running() {
  // The web port rather than the API's: it is the one a person recognises as
  // "ZuSu is open", and either half holding the engine file is enough to stop
  // the rebuild.
  for (const url of ['http://localhost:5173', 'http://127.0.0.1:4000/api/system/live']) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      /* not answering is the answer */
    }
  }
  return false;
}

async function main() {
  const env = loadEnvFor(root, process.env);
  console.log('\n  Updating ZuSu Trading\n');

  // Before anything: an update while ZuSu is open cannot finish on Windows,
  // and failing half-way is worse than not starting.
  if (await running()) {
    throw new Error(
      'ZuSu is running, and it has to be closed to update.\n\n' +
        'Windows will not let a file be replaced while a program has it open, so the\n' +
        'update would stop half-way through rebuilding the database client.\n\n' +
        'Close the ZuSu window, then run this again.',
    );
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.status !== 0) {
    throw new Error(
      'This folder is not a copy of ZuSu that can be updated.\n\n' +
        'It has no git history, which usually means it was copied rather than cloned.',
    );
  }
  console.log(`  Branch: ${branch.out}\n`);

  console.log('  Checking for changes…');
  const fetched = git(['fetch', 'origin', branch.out]);
  if (fetched.status !== 0) {
    throw new Error(
      `Could not reach GitHub.\n\n${fetched.err}\n\n` +
        'If you are offline this is expected — ZuSu still runs, it simply will not change.',
    );
  }

  const behind = git(['rev-list', '--count', `HEAD..origin/${branch.out}`]);
  const unfinished = existsSync(UNFINISHED);

  if (behind.out === '0' && !unfinished) {
    console.log('\n  Already up to date. Nothing to do.\n');
    return;
  }

  if (behind.out === '0') {
    // The code is current and the build is not: a previous run pulled and then
    // stopped. Returning "nothing to do" here would leave the only tool that
    // can finish it refusing to.
    console.log('  The last update did not finish. Completing it.\n');
  } else {
    console.log(`  ${behind.out} new change(s) to bring in.\n`);
  }

  const { generated, authored: edits } = classifyEdits(git(['status', '--porcelain']).out);

  if (generated.length > 0) {
    // Said out loud rather than done quietly. Restoring a file is discarding
    // something, and even a generated file is worth one line of explanation.
    console.log(`  Restoring ${generated.join(', ')} — npm rewrites it, nobody edits it.\n`);
    git(['checkout', '--', ...generated]);
  }

  // Only when a pull is actually going to happen. Finishing an interrupted
  // update overwrites nothing, so refusing it over an edit would strand the
  // one case this tool exists to recover from.
  if (edits.length > 0 && behind.out !== '0') {
    // Never discarded silently. A pull that throws away someone's edit is a
    // convenience that costs them work they cannot get back.
    throw new Error(
      'You have edited files here, and updating would overwrite them:\n\n' +
        edits.map((f) => `    ${f}`).join('\n') +
        '\n\nNothing has been changed. If those edits were not deliberate, a\n' +
        'developer can undo them; if they were, save a copy first.',
    );
  }

  if (behind.out !== '0') {
    const pulled = git(['pull', '--ff-only', 'origin', branch.out]);
    if (pulled.status !== 0) {
      throw new Error(`The update could not be applied.\n\n${pulled.err || pulled.out}`);
    }
  }

  // From here the checkout is newer than the build, and saying otherwise after
  // a failure would be a false reassurance.
  writeFileSync(UNFINISHED, new Date().toISOString());

  npm('Installing anything new…', ['install'], env);
  npm('Rebuilding the shared code…', ['run', 'build', '-w', '@zusu/shared'], env);
  npm('Updating the database…', ['run', 'db:deploy'], env);
  // Explicit, not left to npm: when no dependency changed, `npm install` does
  // no work and does not re-run the install script that would have rebuilt
  // this. An update carrying only a migration would then leave the code that
  // reads the database a version behind it.
  npm('Matching the database tools to it…', ['run', 'db:generate'], env);

  // And again afterwards: the install that just ran may have rewritten it,
  // which would leave the next update refusing over this one's side effect.
  const after = classifyEdits(git(['status', '--porcelain']).out);
  if (after.generated.length > 0) git(['checkout', '--', ...after.generated]);

  rmSync(UNFINISHED, { force: true });
  console.log('\n  Done. Start ZuSu the usual way — the icon on your desktop.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ZuSu could not be updated.\n\n  ${message.split('\n').join('\n  ')}\n`);

    const advice = adviceForUpdate(message);
    if (advice) console.error(`  ${advice.split('\n').join('\n  ')}\n`);

    // Accurate rather than reassuring. Once the pull has happened the code on
    // disk is new and the build is not, and claiming otherwise is the kind of
    // false comfort that sends somebody looking for the problem elsewhere.
    console.error(
      existsSync(UNFINISHED)
        ? '  The new code is here but not finished building. Starting ZuSu completes it,\n' +
            '  and so does running this update again.\n'
        : '  Nothing was changed: ZuSu still runs as it did before.\n',
    );
    process.exitCode = 1;
  }
}
