import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { replaceGuestTools } from '../../scripts/v86-guest-files.mjs';
import { replaceGuestArtifacts } from '../../scripts/v86-guest-update.mjs';
import { GUEST_MANIFEST_SCHEMA, treeRecord } from '../../scripts/v86-guest-manifest.mjs';

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
	const { nvpn: record } = await replaceGuestTools(filesystem, directory, { nvpn: binary });
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
	await assert.rejects(replaceGuestTools(filesystem, directory, { nvpn: Buffer.from('another') }), /exactly one nvpn/u);
	assert.equal(JSON.stringify(filesystem), before);
	assert.deepEqual(await readFile(path.join(directory, nativeEntry[6])), unchangedBinary);
});

async function guestFixture(t) {
	const directory = await mkdtemp(path.join(tmpdir(), 'webvm-artifacts-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const guestDirectory = path.join(directory, 'guest');
	const rootfs = path.join(guestDirectory, 'rootfs');
	await mkdir(rootfs, { recursive: true });
	const toolNames = ['nvpn', 'htree', 'git-remote-htree'];
	const entries = toolNames.map((name, id) => [name, 3, 1, 0o100755, 0, 0, `old-${id}.bin.zst`]);
	const receiptEntry = ['webvm-guest-binaries.sha256', 1, 1, 0o100644, 0, 0, 'receipt.bin.zst'];
	const originalReceipt = toolNames.map((name) => `${'a'.repeat(64)}  /usr/local/bin/${name}\n`).join('');
	const filesystem = { fsroot: [
		['usr', 0, 0, 0, 0, 0, [['local', 0, 0, 0, 0, 0, [['bin', 0, 0, 0, 0, 0, entries]]]]],
		['etc', 0, 0, 0, 0, 0, [receiptEntry]],
	] };
	for (const entry of entries) await writeFile(path.join(rootfs, entry[6]), Buffer.from('old'));
	await writeFile(path.join(rootfs, receiptEntry[6]), execFileSync('zstd', ['--quiet', '-c'], { input: originalReceipt }));
	await writeFile(path.join(guestDirectory, 'fs.json'), JSON.stringify(filesystem));
	await writeFile(path.join(guestDirectory, 'manifest.json'), JSON.stringify({
		schema: GUEST_MANIFEST_SCHEMA, binaries: {}, sources: {}, artifacts: {},
	}));
	await mkdir(path.join(guestDirectory, 'state'));
	await writeFile(path.join(guestDirectory, 'state/state-000.bin'), 'old identity-free state');
	const binaries = Object.fromEntries(['nvpn', 'htree', 'gitRemoteHtree'].map((name) => [name, {
		data: Buffer.from(`new-${name}`), version: '1.2.3', format: 'fixture',
	}]));
	return { directory, guestDirectory, rootfs, filesystem, binaries, receiptEntry,
		backupParent: path.join(directory, 'backups'), sources: { nvpn: { commit: 'a'.repeat(40), dirty: false } } };
}

test('all guest tools and checksum entries update together with a complete recovery copy', async (t) => {
	const fixture = await guestFixture(t);
	const before = await treeRecord(fixture.guestDirectory);
	const result = await replaceGuestArtifacts(fixture);
	assert.deepEqual(await treeRecord(result.previousDirectory), before);
	const manifest = JSON.parse(await readFile(path.join(fixture.guestDirectory, 'manifest.json')));
	const filesystem = JSON.parse(await readFile(path.join(fixture.guestDirectory, 'fs.json')));
	const tools = filesystem.fsroot[0][6][0][6][0][6];
	const receipt = execFileSync('zstd', ['--quiet', '-dc', path.join(fixture.rootfs, filesystem.fsroot[1][6][0][6])], { encoding: 'utf8' });
	for (const [index, [name, binary]] of Object.entries(Object.entries(fixture.binaries))) {
		const hash = createHash('sha256').update(binary.data).digest('hex');
		assert.equal(manifest.binaries[name].sha256, hash);
		assert.equal(manifest.binaries[name].version, '1.2.3');
		assert.deepEqual(execFileSync('zstd', ['--quiet', '-dc', path.join(fixture.rootfs, tools[index][6])]), binary.data);
		assert(receipt.includes(`${hash}  /usr/local/bin/${tools[index][0]}\n`));
	}
	assert.deepEqual(manifest.artifacts.rootfs, await treeRecord(fixture.rootfs));
	assert.equal(await readFile(path.join(fixture.guestDirectory, 'state/state-000.bin'), 'utf8'), 'old identity-free state');
});

test('failed staged image validation leaves every original artifact intact', async (t) => {
	const fixture = await guestFixture(t);
	// A nonregular artifact is rejected during the final inventory, after staging all new tool bytes.
	await symlink('old-0.bin.zst', path.join(fixture.rootfs, 'unsupported-link'));
	const before = await readFile(path.join(fixture.guestDirectory, 'fs.json'));
	const oldManifest = await readFile(path.join(fixture.guestDirectory, 'manifest.json'));
	await assert.rejects(replaceGuestArtifacts(fixture), /Unsupported guest artifact/u);
	assert.deepEqual(await readFile(path.join(fixture.guestDirectory, 'fs.json')), before);
	assert.deepEqual(await readFile(path.join(fixture.guestDirectory, 'manifest.json')), oldManifest);
	assert.equal(await readFile(path.join(fixture.rootfs, 'old-0.bin.zst'), 'utf8'), 'old');
	assert.deepEqual(await readdir(fixture.backupParent), []);
});

test('replacement refuses paths outside the tool allowlist and preserves shared old blobs', async (t) => {
	const fixture = await guestFixture(t);
	await assert.rejects(replaceGuestTools(fixture.filesystem, fixture.rootfs, { '/root/private': Buffer.from('no') }), /Select only/u);
	const tools = fixture.filesystem.fsroot[0][6][0][6][0][6];
	tools[1][6] = tools[0][6];
	await replaceGuestTools(fixture.filesystem, fixture.rootfs, { nvpn: Buffer.from('new') });
	assert.equal(await readFile(path.join(fixture.rootfs, tools[1][6]), 'utf8'), 'old');
	tools[2][6] = '../../private.bin.zst';
	await assert.rejects(replaceGuestTools(fixture.filesystem, fixture.rootfs,
		{ gitRemoteHtree: Buffer.from('new') }), /local content-addressed blob/u);
});
