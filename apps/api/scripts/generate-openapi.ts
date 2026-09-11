/**
 * Writes the OpenAPI document to docs/openapi.json.
 *
 * The spec is generated from the same zod schemas the routes validate against,
 * so it cannot drift from the implementation (§60, §14 of the build rules).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { disconnectPrisma } from '../src/lib/prisma.js';

const OUTPUT = resolve(process.cwd(), '../../docs/openapi.json');

async function main(): Promise<void> {
  const { app } = await buildApp();
  await app.ready();
  const document = app.swagger();

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT}`);

  await app.close();
  await disconnectPrisma();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
