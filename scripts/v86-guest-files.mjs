import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
	return matches[0];
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
	const previousBlobName = entry[6];
	entry[1] = bytes.length;
	entry[2] = Math.floor(Date.now() / 1_000);
	entry[6] = blobName;
	if (previousBlobName !== blobName) {
		await rm(path.join(rootfsDirectory, previousBlobName), { force: true });
	}
	return { sha256, bytes: bytes.length };
}

export async function replaceGuestNvpn(filesystem, rootfsDirectory, binary) {
	const nativeEntry = guestFile(filesystem, '/usr/local/bin/nvpn');
	const receiptEntry = guestFile(filesystem, '/etc/webvm-guest-binaries.sha256');
	const receipt = execFileSync('zstd', ['--quiet', '-dc', path.join(rootfsDirectory, receiptEntry[6])], {
		encoding: 'utf8', maxBuffer: 4096,
	});
	const nativeLine = /^[0-9a-f]{64} {2}\/usr\/local\/bin\/nvpn$/gmu;
	if ([...receipt.matchAll(nativeLine)].length !== 1) {
		throw new Error('Guest checksum receipt must contain exactly one nVPN binary');
	}
	const record = await replaceFile(rootfsDirectory, nativeEntry, binary);
	await replaceFile(rootfsDirectory, receiptEntry, Buffer.from(receipt.replace(
		nativeLine, `${record.sha256}  /usr/local/bin/nvpn`,
	)));
	return record;
}
