import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('deployment always starts from the frozen lockfile', () => {
	const output = execFileSync(
		process.execPath,
		['scripts/deploy-webvm.mjs', '--dry-run'],
		{ encoding: 'utf8' },
	);

	assert.match(output, /Install frozen dependencies: npm ci/u);
	assert.ok(output.indexOf('npm ci') < output.indexOf('npm run test:release'));
});
