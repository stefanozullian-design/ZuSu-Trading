import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The double-click launcher.
 *
 * `scripts/start.mjs` is what a person who never opens a terminal runs, which
 * makes its failure modes worse than a script's usually are: there is nobody
 * at the keyboard who can read a stack trace, and a launcher that opens a
 * browser at the wrong port looks broken in a way that gives no clue at all.
 * Two things are pinned here — the port it opens, and that a database failure
 * still produces an instruction rather than an error code.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const tools = (await import(join(repoRoot, 'scripts/env-tools.mjs'))) as {
  supervisedOptions: (base?: Record<string, unknown>) => Record<string, unknown>;
  killTree: (child: { pid?: number; exitCode: number | null; signalCode: string | null }) => void;
};

const launcher = (await import(join(repoRoot, 'scripts/start.mjs'))) as {
  WEB_PORT: number;
  apiPort: (env: Record<string, string | undefined>) => number;
  webUrl: () => string;
  apiHealthUrl: (env: Record<string, string | undefined>) => string;
  adviceFor: (message: string) => string | null;
};

describe('the port it opens the browser at', () => {
  it('is the port Vite is actually configured to serve', () => {
    const config = readFileSync(join(repoRoot, 'apps/web/vite.config.ts'), 'utf8');
    const declared = /server:\s*\{[\s\S]*?port:\s*(\d+)/.exec(config)?.[1];

    // Vite's port lives in its own config and the launcher cannot read a
    // TypeScript file at start-up, so the number is duplicated. A duplicated
    // number that drifts sends the browser to a blank page, and the person
    // sees a broken app rather than a misconfigured one.
    expect(declared, 'no server.port found in vite.config.ts').toBeDefined();
    expect(launcher.WEB_PORT).toBe(Number(declared));
    expect(launcher.webUrl()).toBe(`http://localhost:${String(launcher.WEB_PORT)}`);
  });
});

describe('the API port it probes', () => {
  it('follows PORT when it is set', () => {
    expect(launcher.apiPort({ PORT: '4300' })).toBe(4300);
    expect(launcher.apiHealthUrl({ PORT: '4300' })).toBe('http://127.0.0.1:4300/api/system/live');
  });

  it('falls back to the API’s own default rather than guessing', () => {
    for (const value of [undefined, '', 'not-a-number', '0', '-1']) {
      expect(launcher.apiPort({ PORT: value })).toBe(4000);
    }
  });
});

describe('what it tells a person when it fails', () => {
  it('turns a refused connection into an instruction', () => {
    const advice = launcher.adviceFor("Can't reach database server at localhost:5432");
    expect(advice).toContain('PostgreSQL does not appear to be running');
    expect(advice).toContain('Services');
  });

  it('turns a Prisma authentication code into the file to edit', () => {
    const advice = launcher.adviceFor('Error: P1000: Authentication failed against database');
    expect(advice).toContain('.env');
    expect(advice).toContain('password');
  });

  it('explains a taken port as the likely second window', () => {
    expect(launcher.adviceFor('listen EADDRINUSE: address already in use')).toContain(
      'already running',
    );
  });

  it('says nothing rather than inventing advice for a failure it does not know', () => {
    // A confident wrong instruction is worse than the raw message, which at
    // least can be searched for.
    expect(launcher.adviceFor('TypeError: undefined is not a function')).toBeNull();
  });
});

/**
 * Is this process still doing anything?
 *
 * Not `process.kill(pid, 0)`, which is the obvious answer and the wrong one: a
 * killed process whose parent has also died is reparented, and in a container
 * where nothing reaps it, it stays as a zombie. Signal 0 succeeds against a
 * zombie, so the obvious check reports a process that is thoroughly dead as
 * alive. The state letter distinguishes them — `Z` is defunct.
 */
function running(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])
      .toString()
      .trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    return false; // ps exits non-zero when there is no such process at all.
  }
}

describe('stopping it', () => {
  it('kills the grandchildren, not just the shell it spawned', async () => {
    // The real shape of the bug this guards: the launcher spawns a shell,
    // which runs npm, which runs tsx or vite. Killing the child killed the
    // shell and left the server holding its port, so closing the window
    // appeared to stop ZuSu and did not — and the next launch then reported
    // "already running" while pointing at an orphan.
    const child = spawn(
      "sh -c 'sleep 60 & echo $!; wait'",
      tools.supervisedOptions({ stdio: ['ignore', 'pipe', 'ignore'] }) as never,
    );

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      child.stdout?.once('data', (chunk: Buffer) => {
        resolve(Number(chunk.toString().trim()));
      });
      child.once('error', reject);
      setTimeout(() => {
        reject(new Error('the child never reported its grandchild'));
      }, 5_000);
    });

    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(running(grandchildPid)).toBe(true);

    tools.killTree(child);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(running(grandchildPid)).toBe(false);
  });
});
