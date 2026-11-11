// Minimal test runner: imports every tests/unit/*.test.mjs file. Each test file
// registers cases with `test(name, fn)` from ./harness.mjs; failures exit 1.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './harness.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'unit');
const only = process.argv[2];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  if (only && !f.includes(only)) continue;
  await import(pathToFileURL(join(dir, f)).href);
}
const ok = await run();
process.exit(ok ? 0 : 1);
