import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { replaceGuestTools } from './v86-guest-files.mjs';
import { GUEST_MANIFEST_SCHEMA, fileRecord, treeRecord } from './v86-guest-manifest.mjs';

export async function replaceGuestArtifacts({ guestDirectory, backupParent, binaries, sources }) {
	await mkdir(backupParent, { recursive: true });
	const transaction = await mkdtemp(path.join(backupParent, 'guest-tools-'));
	const staged = path.join(transaction, 'next');
	const previous = path.join(transaction, 'previous');
	let originalMoved = false;
	try {
		await cp(guestDirectory, staged, { recursive: true, errorOnExist: true });
		const manifestPath = path.join(staged, 'manifest.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
		if (manifest.schema !== GUEST_MANIFEST_SCHEMA) throw new Error('Unsupported guest manifest');
		const filesystemPath = path.join(staged, 'fs.json');
		const filesystem = JSON.parse(await readFile(filesystemPath, 'utf8'));
		const records = await replaceGuestTools(filesystem, path.join(staged, 'rootfs'),
			Object.fromEntries(Object.entries(binaries).map(([name, binary]) => [name, binary.data])));
		for (const [name, record] of Object.entries(records)) {
			manifest.binaries[name] = { ...record, version: binaries[name].version, format: binaries[name].format };
		}
		Object.assign(manifest.sources, sources);
		await writeFile(filesystemPath, JSON.stringify(filesystem));
		manifest.artifacts.fsJson = await fileRecord(filesystemPath);
		manifest.artifacts.rootfs = await treeRecord(path.join(staged, 'rootfs'));
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		// Never modify the current image while preparing. Keep its complete state
		// alongside the new image for recovery, including after a successful swap.
		await rename(guestDirectory, previous);
		originalMoved = true;
		try {
			await rename(staged, guestDirectory);
		} catch (error) {
			await rename(previous, guestDirectory);
			originalMoved = false;
			throw error;
		}
		return { binaries: records, previousDirectory: previous };
	} finally {
		if (!originalMoved) await rm(transaction, { recursive: true, force: true });
	}
}
