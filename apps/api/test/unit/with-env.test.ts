import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The `.env` loader that stops a new contributor being stranded.
 *
 * Nothing in this repository reads `.env` implicitly — the API takes its
 * configuration from the environment — so `scripts/with-env.mjs` bridges the
 * gap for local commands. The property worth pinning is the precedence: a
 * variable already set must survive, because CI and the E2E suite pass their
 * own DATABASE_URL and a loader that clobbered it would point the run at
 * somebody's development database without saying so.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const { parseEnvFile, envWithFile } = (await import(join(repoRoot, 'scripts/env-tools.mjs'))) as {
  parseEnvFile: (contents: string) => Record<string, string>;
  envWithFile: (
    base: Record<string, string | undefined>,
    contents: string,
  ) => Record<string, string | undefined>;
};

describe('parseEnvFile', () => {
  it('reads plain pairs, quotes and an export prefix', () => {
    const values = parseEnvFile(
      ['A=1', 'B="two"', "C='three'", 'export D=4', '', '# a comment', 'E=has=equals'].join('\n'),
    );
    expect(values).toEqual({ A: '1', B: 'two', C: 'three', D: '4', E: 'has=equals' });
  });

  it('ignores a line with no key', () => {
    expect(parseEnvFile('=novalue\nF=6')).toEqual({ F: '6' });
  });
});

describe('envWithFile', () => {
  it('fills gaps', () => {
    expect(envWithFile({ KEEP: 'me' }, 'NEW=value').NEW).toBe('value');
  });

  it('never overrides a variable already set', () => {
    const merged = envWithFile({ DATABASE_URL: 'from-ci' }, 'DATABASE_URL=from-dotenv');
    expect(merged.DATABASE_URL).toBe('from-ci');
  });
});

describe('launching npm', () => {
  it('spells npm the way the current platform can spawn it', async () => {
    const { npmCommand } = (await import(join(repoRoot, 'scripts/env-tools.mjs'))) as {
      npmCommand: () => string;
    };
    // `spawn('npm')` without a shell is ENOENT on Windows, which reads like npm
    // is missing rather than merely spelled differently.
    expect(npmCommand()).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  });

  it('runs through a shell, keeping the caller’s options', async () => {
    const { spawnOptions } = (await import(join(repoRoot, 'scripts/env-tools.mjs'))) as {
      spawnOptions: (base?: Record<string, unknown>) => Record<string, unknown>;
    };
    // Since Node 20.12, spawning a .cmd without a shell fails with EINVAL —
    // an error that names nothing and reads like a bad argument.
    const options = spawnOptions({ cwd: '/somewhere', stdio: 'inherit' });
    expect(options.cwd).toBe('/somewhere');
    expect(options.shell).toBe(true);
  });

  it('builds one command line rather than an args array', async () => {
    const { npmCommandLine } = (await import(join(repoRoot, 'scripts/env-tools.mjs'))) as {
      npmCommandLine: (args: string[]) => string;
    };
    // An args array alongside shell:true makes Node print a DeprecationWarning
    // about unescaped arguments on every start, which reads like a security
    // problem to anyone who is not a Node developer.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    expect(npmCommandLine(['run', 'dev', '-w', '@zusu/api'])).toBe(`${npm} run dev -w @zusu/api`);
  });
});

describe('argument pass-through', () => {
  it('lets a root script forward its own arguments to the workspace script', () => {
    // `npm run sync:market -- --days 90` appends `--days 90` to the root
    // script, and npm then reads those as *its* flags unless a `--` separates
    // them. Without the marker the arguments were silently dropped: the
    // command reported 365 days while the user had asked for 90, and nothing
    // said otherwise.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['sync:market']?.trimEnd().endsWith('--')).toBe(true);
  });
});

describe('the repository’s own .env.example', () => {
  it('declares the three secrets setup generates', () => {
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    for (const key of ['JWT_SECRET', 'COOKIE_SECRET', 'CREDENTIAL_ENCRYPTION_KEY']) {
      expect(example).toContain(key);
    }
  });
});
