import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [output, ...extra] = process.argv.slice(2);
assert.ok(output && extra.length === 0, 'Usage: node scripts/release-webvm-hashtree.mjs <new-staging-directory>');

const gate = process.env.IRIS_NATIVE_RELEASE_GATE;
assert.ok(gate && path.isAbsolute(gate) && statSync(gate, { throwIfNoEntry: false })?.isFile(),
  'Set IRIS_NATIVE_RELEASE_GATE to the installed Iris Sites native release runner');

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const stageScript = fileURLToPath(new URL('./stage-webvm-hashtree.mjs', import.meta.url));
const stage = path.resolve(output);
run([stageScript, stage]);
copyFileSync(new URL('../LICENSE.txt', import.meta.url), path.join(stage, 'LICENSE.txt'));
run([gate, '--dist', stage, '--tree', 'webvm-site', '--htree', process.env.HTREE_BIN || 'htree']);
