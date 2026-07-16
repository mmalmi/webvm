import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

test('WebVM publishes the Iris Sites WebVM icon from the application shell', () => {
	const appShell = readFileSync('src/app.html', 'utf8');
	const favicon = readFileSync('static/favicon.ico');

	assert.match(appShell, /<link rel="icon" href="\/favicon\.ico" type="image\/x-icon" \/>/u);
	assert.equal(
		createHash('sha256').update(favicon).digest('hex'),
		'dc2f76594bb52e11467f8e78a529d473557dfece4b277bd6e0c2625b90ee365b',
	);
});
