import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approveWithCli, supportsCliApproval } from '../e2e/helpers/webvm-cli-approval.js';

test('queued CLI approval requires the requested device and guest-side delivery', async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), 'webvm-queued-approval-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const binary = path.join(root, 'nvpn.cjs');
	const device = 'a'.repeat(64);
	const request = 'nvpn://join-request/' + Buffer.from(JSON.stringify({
		deviceAppKeyNpub: device,
	})).toString('base64url');
	writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'status') {
	console.log(JSON.stringify({ daemon: { running: true } }));
} else if (args.join(' ') === 'join-requests approve --help') {
	console.log('approve');
} else if (args[0] === 'join-requests' && args[1] === 'approve' && args.includes('--json')) {
	const file = args[args.indexOf('--request-file') + 1];
	if (fs.readFileSync(file, 'utf8') !== ${JSON.stringify(request)} || (fs.statSync(file).mode & 0o077)) process.exit(2);
	console.log(JSON.stringify({ approved: true, delivery: 'queued', device_id: ${JSON.stringify(device)}, roster_event_id: 'b'.repeat(64) }));
} else process.exit(1);
`, { mode: 0o700 });
	assert.equal(supportsCliApproval(binary), true);
	const waitUntil = async (check, { message }) => {
		if (!await check()) throw new Error(message);
	};
	const approve = (applied) => approveWithCli({
		binary, adminConfig: path.join(root, 'config.toml'), request, waitUntil,
		dataDir: mkdtempSync(path.join(root, 'request-')), guestApplied: () => applied, timeoutMs: 100,
	});
	await assert.rejects(approve(false), /Guest did not apply the signed roster/u);
	const [approved, delivered] = await approve(true);
	assert.equal(approved.recipient, device);
	assert.equal(approved.rosterEventId, 'b'.repeat(64));
	assert.deepEqual(delivered, { ok: true, event: 'delivered', recipient: device });
});
