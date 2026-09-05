import { execFileSync } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	GUEST_MANIFEST_SCHEMA,
	fileRecord,
	gitRecord,
	treeRecord,
} from './v86-guest-manifest.mjs';
import { replaceGuestNvpn } from './v86-guest-files.mjs';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guestDirectory = path.join(appDirectory, 'custom-disk-images/v86-guest');
const rootfsDirectory = path.join(guestDirectory, 'rootfs');
const [binaryArgument, nvpnRepositoryArgument, fipsRepositoryArgument] = process.argv.slice(2);

if (!binaryArgument || !nvpnRepositoryArgument || !fipsRepositoryArgument) {
	throw new Error(
		'replace-v86-guest-nvpn requires an i386 binary, nVPN repository, and FIPS repository',
	);
}

const binary = path.resolve(binaryArgument);
const repositories = {
	webvm: appDirectory,
	nvpn: path.resolve(nvpnRepositoryArgument),
	fips: path.resolve(fipsRepositoryArgument),
};
const sources = Object.fromEntries(
	Object.entries(repositories).map(([name, repository]) => [name, gitRecord(repository)]),
);
const dirtySources = Object.entries(sources)
	.filter(([, source]) => source.dirty)
	.map(([name]) => name);
if (dirtySources.length > 0) {
	throw new Error(`Refusing to replace the guest binary from dirty sources: ${dirtySources.join(', ')}`);
}

const description = execFileSync('file', ['-b', binary], { encoding: 'utf8' }).trim();
if (!description.includes('ELF 32-bit LSB')
	|| !description.includes('Intel 80386')
	|| !description.includes('statically linked')) {
	throw new Error(`nVPN is not a static i386 ELF binary: ${description}`);
}

const filesystemPath = path.join(guestDirectory, 'fs.json');
const filesystem = JSON.parse(await readFile(filesystemPath, 'utf8'));
const binaryRecord = await replaceGuestNvpn(filesystem, rootfsDirectory, await readFile(binary));

const temporaryFilesystemPath = `${filesystemPath}.${process.pid}.tmp`;
await writeFile(temporaryFilesystemPath, JSON.stringify(filesystem), { mode: 0o644 });
await rename(temporaryFilesystemPath, filesystemPath);

const manifestPath = path.join(guestDirectory, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.schema !== GUEST_MANIFEST_SCHEMA) {
	throw new Error(`Unsupported guest manifest schema: ${manifest.schema}`);
}
Object.assign(manifest.sources, sources);
manifest.binaries.nvpn = { ...binaryRecord, format: description };
manifest.artifacts.fsJson = await fileRecord(filesystemPath);
manifest.artifacts.rootfs = await treeRecord(rootfsDirectory);

const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
await rename(temporaryManifestPath, manifestPath);

console.log(`${binaryRecord.sha256.slice(0, 8)}.bin.zst ${binaryRecord.bytes} bytes`);
