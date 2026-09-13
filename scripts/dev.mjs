#!/usr/bin/env node
/**
 * Starts the API and the web client together, on any operating system.
 *
 * This used to be `npm run dev:api & npm run dev:web` in package.json. On
 * macOS and Linux `&` backgrounds the first command; on Windows, where npm
 * runs scripts through cmd.exe, `&` means "then" — so the web client would not
 * start until the API stopped, and `npm run dev` appeared to hang with a blank
 * page at localhost:5173. Spawning both from Node removes the shell from the
 * question entirely.
 *
 * Ctrl-C stops both. If either exits on its own, the other is stopped too: a
 * half-running stack that still answers on one port is worse than one that is
 * plainly down.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFor, npmCommandLine, spawnOptions } from './env-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = loadEnvFor(root, process.env);

const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exitCode = code ?? 0;
}

function start(name, args) {
  const child = spawn(npmCommandLine(args), spawnOptions({ cwd: root, env, stdio: 'inherit' }));
  child.on('error', (error) => {
    console.error(`\n${name} could not start: ${error.message}`);
    stopAll(1);
  });
  // A half that dies during start-up is the common case — a bad .env, a
  // database that is not running — and leaving the other half up means a page
  // that loads with nothing behind it. Worse than both being down, because it
  // looks like it worked.

  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`\n${name} exited (${String(code)}); stopping the other half too.`);
      stopAll(code ?? 1);
    }
  });
  children.push(child);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

start('the API', ['run', 'dev', '-w', '@zusu/api']);
start('the web client', ['run', 'dev', '-w', '@zusu/web']);
