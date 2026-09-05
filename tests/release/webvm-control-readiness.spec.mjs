import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertApprovedJoinRequest } from '../e2e/helpers/webvm-control-readiness.js';

test('approved-join assertion stays strict and diagnoses failures without retrying', async (t) => {
	const directory = mkdtempSync(path.join(tmpdir(), 'webvm-control-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, 'nvpn'), '#!/bin/sh\n' +
		'[ "$*" = "join-request --no-qr --no-wait" ] || exit 99\n' +
		'printf "%s\\n" "$MOCK_JOIN_OUTPUT"; exit "$MOCK_JOIN_STATUS"\n', { mode: 0o755 });
	for (const [output, status, expectedError] of [
		['Error: this device is already approved for its active network', 1, null],
		['nvpn://join-request/unexpected', 0, /unexpectedly received another request/u],
		['Error: timed out handling the daemon join-request IPC', 1, /timed out handling/u],
	]) {
		let calls = 0;
		const assertion = assertApprovedJoinRequest({
			page: null,
			runSerialCommand: async (_page, label, command) => {
				calls += 1;
				if (label === 'post-approval control diagnostics') {
					return ['__CONTROL__', 'nvpn://join-request/private', 'a'.repeat(64)];
				}
				const result = spawnSync('/bin/sh', ['-c', command], {
					env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
						MOCK_JOIN_OUTPUT: output, MOCK_JOIN_STATUS: String(status) },
					encoding: 'utf8',
				});
				if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
				return [];
			},
		});
		if (expectedError) {
			await assert.rejects(assertion, (error) => {
				assert.match(error.message, expectedError);
				assert.match(error.message, /__CONTROL__/u);
				assert.doesNotMatch(error.message, /nvpn:\/\/|a{64}/u);
				return true;
			});
			assert.equal(calls, 2);
		} else {
			await assertion;
			assert.equal(calls, 1);
		}
	}
});
