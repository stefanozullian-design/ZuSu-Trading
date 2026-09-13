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
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFor, npmCommandLine, spawnOptions } from './env-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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

/** Files the person changed themselves, which a pull would overwrite. */
export function localEdits(porcelain) {
  return (
    porcelain
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // Untracked files are not in the way of a pull; modified tracked ones are.
      .filter((line) => !line.startsWith('??'))
      .map((line) => line.slice(2).trim())
  );
}

function main() {
  const env = loadEnvFor(root, process.env);
  console.log('\n  Updating ZuSu Trading\n');

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
  if (behind.out === '0') {
    console.log('\n  Already up to date. Nothing to do.\n');
    return;
  }
  console.log(`  ${behind.out} new change(s) to bring in.\n`);

  const edits = localEdits(git(['status', '--porcelain']).out);
  if (edits.length > 0) {
    // Never discarded silently. A pull that throws away someone's edit is a
    // convenience that costs them work they cannot get back.
    throw new Error(
      'You have edited files here, and updating would overwrite them:\n\n' +
        edits.map((f) => `    ${f}`).join('\n') +
        '\n\nNothing has been changed. If those edits were not deliberate, a\n' +
        'developer can undo them; if they were, save a copy first.',
    );
  }

  const pulled = git(['pull', '--ff-only', 'origin', branch.out]);
  if (pulled.status !== 0) {
    throw new Error(`The update could not be applied.\n\n${pulled.err || pulled.out}`);
  }

  npm('Installing anything new…', ['install'], env);
  npm('Rebuilding the shared code…', ['run', 'build', '-w', '@zusu/shared'], env);
  npm('Updating the database…', ['run', 'db:deploy'], env);

  console.log('\n  Done. Start ZuSu the usual way — the icon on your desktop.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ZuSu could not be updated.\n\n  ${message.split('\n').join('\n  ')}\n`);
    console.error('  Nothing was half-applied: ZuSu still runs as it did before.\n');
    process.exitCode = 1;
  }
}
