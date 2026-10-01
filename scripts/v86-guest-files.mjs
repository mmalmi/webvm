import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WEBVM_GUEST_CHECKSUMS, WEBVM_GUEST_TOOLS } from '../src/lib/webvmGuestTools.js';

function guestFile(filesystem, name) {
	const matches = [];
	function walk(entries, parent = '') {
		for (const entry of entries) {
			const entryPath = `${parent}/${entry[0]}`;
			if (entryPath === name) matches.push(entry);
			if (Array.isArray(entry[6])) walk(entry[6], entryPath);
		}
	}
	walk(filesystem.fsroot);
	if (matches.length !== 1) throw new Error(`Expected one ${name} entry, found ${matches.length}`);
	const entry = matches[0];
	if (typeof entry[6] !== 'string' || !/^[\w-]+\.bin\.zst$/u.test(entry[6])) {
		throw new Error(`Expected a local content-addressed blob for ${name}`);
	}
	return entry;
}

async function replaceFile(rootfsDirectory, entry, bytes) {
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const blobName = `${sha256.slice(0, 8)}.bin.zst`;
	const blobPath = path.join(rootfsDirectory, blobName);
	const temporaryBlobPath = `${blobPath}.${process.pid}.tmp`;
	const compressed = execFileSync('zstd', ['--quiet', '-19', '-c'], {
		input: bytes, maxBuffer: bytes.length + 1024 * 1024,
	});
	await writeFile(temporaryBlobPath, compressed);
	await rename(temporaryBlobPath, blobPath);
	entry[1] = bytes.length;
	entry[2] = Math.floor(Date.now() / 1_000);
	entry[6] = blobName;
	return { sha256, bytes: bytes.length };
}

export async function replaceGuestTools(filesystem, rootfsDirectory, binaries) {
	const names = Object.keys(binaries);
	if (!names.length || names.some((name) => !Object.hasOwn(WEBVM_GUEST_TOOLS, name))) {
		throw new Error('Select only nvpn, htree, or gitRemoteHtree guest tools');
	}
	const receiptEntry = guestFile(filesystem, WEBVM_GUEST_CHECKSUMS);
	const receipt = execFileSync('zstd', ['--quiet', '-dc', path.join(rootfsDirectory, receiptEntry[6])], {
		encoding: 'utf8', maxBuffer: 4096,
	});
	// Validate the complete allowlisted set before changing even the staged filesystem.
	const updates = names.map((name) => {
		const filePath = WEBVM_GUEST_TOOLS[name];
		const entry = guestFile(filesystem, filePath);
		const lines = receipt.split('\n').filter((line) => line.endsWith(`  ${filePath}`));
		if (lines.length !== 1 || !/^[0-9a-f]{64} {2}\//u.test(lines[0])) {
			throw new Error(`Guest checksum receipt must contain exactly one ${name} binary`);
		}
		if (!Buffer.isBuffer(binaries[name]) || !binaries[name].length) {
			throw new Error(`Missing ${name} binary bytes`);
		}
		return { name, entry, filePath, line: lines[0] };
	});
	let nextReceipt = receipt;
	const records = {};
	const previousBlobs = new Set([receiptEntry[6], ...updates.map(({ entry }) => entry[6])]);
	for (const { name, entry, filePath, line } of updates) {
		records[name] = await replaceFile(rootfsDirectory, entry, binaries[name]);
		nextReceipt = nextReceipt.replace(line, `${records[name].sha256}  ${filePath}`);
	}
	await replaceFile(rootfsDirectory, receiptEntry, Buffer.from(nextReceipt));
	function retainReferenced(entries) {
		for (const entry of entries) {
			if (Array.isArray(entry[6])) retainReferenced(entry[6]);
			else previousBlobs.delete(entry[6]);
		}
	}
	retainReferenced(filesystem.fsroot);
	for (const blob of previousBlobs) await rm(path.join(rootfsDirectory, blob), { force: true });
	return records;
}
