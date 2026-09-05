import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { replaceGuestNvpn } from '../../scripts/v86-guest-files.mjs';

test('guest binary replacement updates its compressed checksum receipt and removes stale blobs', async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'webvm-replace-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const nativeEntry = ['nvpn', 3, 1, 0, 0, 0, 'old-native.bin.zst'];
	const receiptEntry = ['webvm-guest-binaries.sha256', 1, 1, 0, 0, 0, 'old-receipt.bin.zst'];
	const filesystem = { fsroot: [
		['usr', 0, 0, 0, 0, 0, [['local', 0, 0, 0, 0, 0, [['bin', 0, 0, 0, 0, 0, [nativeEntry]]]]]],
		['etc', 0, 0, 0, 0, 0, [receiptEntry]],
	] };
	const otherReceipt = `${'b'.repeat(64)}  /usr/local/bin/htree\n`;
	const originalReceipt = `${'a'.repeat(64)}  /usr/local/bin/nvpn\n${otherReceipt}`;
	await writeFile(path.join(directory, nativeEntry[6]), Buffer.from('old'));
	await writeFile(path.join(directory, receiptEntry[6]), execFileSync('zstd', ['--quiet', '-c'], {
		input: originalReceipt,
	}));
	const binary = Buffer.from('replacement native executable');
	const expectedHash = createHash('sha256').update(binary).digest('hex');
	const record = await replaceGuestNvpn(filesystem, directory, binary);
	assert.deepEqual(record, { sha256: expectedHash, bytes: binary.length });
	assert.equal(nativeEntry[1], binary.length);
	assert.deepEqual(execFileSync('zstd', ['--quiet', '-dc', path.join(directory, nativeEntry[6])]), binary);
	const receipt = execFileSync('zstd', ['--quiet', '-dc', path.join(directory, receiptEntry[6])], { encoding: 'utf8' });
	assert.equal(receipt, `${expectedHash}  /usr/local/bin/nvpn\n${otherReceipt}`);
	assert.equal(receiptEntry[1], Buffer.byteLength(receipt));
	assert.deepEqual((await readdir(directory)).sort(), [nativeEntry[6], receiptEntry[6]].sort());
	const before = JSON.stringify(filesystem);
	await writeFile(path.join(directory, receiptEntry[6]), execFileSync('zstd', ['--quiet', '-c'], {
		input: otherReceipt,
	}));
	const unchangedBinary = await readFile(path.join(directory, nativeEntry[6]));
	await assert.rejects(replaceGuestNvpn(filesystem, directory, Buffer.from('another')), /exactly one nVPN/u);
	assert.equal(JSON.stringify(filesystem), before);
	assert.deepEqual(await readFile(path.join(directory, nativeEntry[6])), unchangedBinary);
});
