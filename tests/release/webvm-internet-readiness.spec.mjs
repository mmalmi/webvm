import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { waitForPrivateExitInternet } from '../e2e/helpers/webvm-internet-readiness.js';

test('Internet failures retain the original error and run bounded payload-free probes once', async (t) => {
	const directory = mkdtempSync(path.join(tmpdir(), 'webvm-internet-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const calls = path.join(directory, 'calls');
	for (const tool of ['dig', 'ping', 'curl', 'timeout']) {
		writeFileSync(path.join(directory, tool), '#!/bin/sh\n' +
			'printf "%s %s\\n" "${0##*/}" "$*" >> "$PROBE_CALLS"\n' +
			(tool === 'timeout' ? '[ "$1" = 35 ] || exit 99; shift; exec "$@"\n' :
				'echo "private response payload"\n' +
				(tool === 'dig' ? 'echo ";; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 1"; exit 9\n' :
					tool === 'curl' ? 'echo "http_status=200 connect_s=0.01 tls_s=0.02 total_s=0.03"\n' : 'exit 1\n')),
			{ mode: 0o755 });
	}
	for (const diagnosticFailure of [false, true]) {
		const original = new Error('package indexes failed');
		let diagnostics = 0;
		await assert.rejects(waitForPrivateExitInternet({
			page: null,
			runSerialCommand: async (_page, label, command, timeoutMs) => {
				if (label.includes('ICMP readiness')) return [];
				if (label !== 'failure-only Internet diagnostics') throw original;
				diagnostics += 1;
				assert.equal(timeoutMs, 45_000);
				if (diagnosticFailure) throw new Error('private timeout output');
				const result = spawnSync('/bin/sh', ['-c', command], {
					env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, PROBE_CALLS: calls },
					encoding: 'utf8', timeout: 5_000,
				});
				assert.equal(result.status, 0, result.stderr);
				return result.stdout.trim().split('\n');
			},
		}), (error) => {
			assert.equal(error, original);
			assert.match(error.message, /^package indexes failed/u);
			assert.doesNotMatch(error.message, /private response|private timeout/u);
			assert.match(error.message, diagnosticFailure ? /exceeded their deadline/u : /status: SERVFAIL/u);
			return true;
		});
		assert.equal(diagnostics, 1);
	}
	const commands = readFileSync(calls, 'utf8').split('\n').filter(Boolean).slice(1);
	assert.equal(commands.length, 7);
	assert.equal(commands.filter((command) => command.startsWith('dig ')).length, 4);
	assert.ok(commands.filter((command) => command.startsWith('dig ')).every((command) => command.includes('+tries=1')));
	assert.equal(commands.filter((command) => command.includes('+tcp')).length, 1);
	for (const command of commands.filter((command) => command.startsWith('curl '))) {
		assert.match(command, /--max-time 5 --output \/dev\/null/u);
		assert.match(command, /--resolve one\.one\.one\.one:(80|443):1\.1\.1\.1/u);
		assert.doesNotMatch(command, /--insecure|--location/u);
	}
});

test('successful Internet checks do not run failure diagnostics', async () => {
	const labels = [];
	await waitForPrivateExitInternet({ page: null, runSerialCommand: async (_page, label, command) => {
		labels.push(label);
		if (label.includes('package indexes')) {
			assert.equal(command, 'timeout 90 apk update');
		}
		assert.doesNotMatch(command, /for i in|seq 1 5/u, 'first-use failures must not be hidden by retries');
		return [];
	} });
	assert.equal(labels.length, 6);
	assert.match(labels[1], /package indexes/u);
	assert.ok(labels.every((label) => !label.includes('diagnostics')));
});
