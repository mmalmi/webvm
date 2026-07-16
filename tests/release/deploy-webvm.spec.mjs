import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('WebVM publishes its SVG favicon from the application shell', () => {
	const appShell = readFileSync('src/app.html', 'utf8');
	const favicon = readFileSync('static/favicon.svg', 'utf8');

	assert.match(appShell, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/u);
	assert.match(favicon, /<svg[^>]+viewBox="0 0 64 64"/u);
	assert.doesNotMatch(favicon, /<(?:script|image)\b/iu);
});
