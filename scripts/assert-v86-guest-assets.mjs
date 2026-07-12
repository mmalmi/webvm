import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	GUEST_MANIFEST_SCHEMA,
	fileRecord,
	treeRecord,
} from './v86-guest-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'custom-disk-images/v86-guest');
const manifestPath = path.join(outputDirectory, 'manifest.json');
let manifest;
try {
	manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
	throw new Error('Missing or invalid v86 guest manifest; run npm run guest:build');
}

if (manifest.schema !== GUEST_MANIFEST_SCHEMA) {
	throw new Error(`Unsupported v86 guest manifest schema: ${manifest.schema}`);
}
if (!manifest.baseImage?.startsWith('i386/alpine:3.22@sha256:')) {
	throw new Error('v86 guest manifest does not pin an i386 Alpine base image');
}
if (manifest.containerImage?.architecture !== '386') {
	throw new Error('v86 guest manifest does not attest a 386 container image');
}

for (const name of ['webvm', 'nvpn', 'hashtree', 'fips', 'v86']) {
	const source = manifest.sources?.[name];
	if (!source || source.dirty !== false || !validGitCommit(source.commit)) {
		throw new Error(`v86 guest source ${name} was not attested clean`);
	}
}

for (const [name, binary] of Object.entries(manifest.binaries ?? {})) {
	if (
		!binary.format?.includes('ELF 32-bit LSB') ||
		!binary.format?.includes('Intel 80386') ||
		!validSha256(binary.sha256) ||
		!Number.isSafeInteger(binary.bytes) ||
		binary.bytes <= 0
	) {
		throw new Error(`Invalid ${name} binary provenance in v86 guest manifest`);
	}
}
if (Object.keys(manifest.binaries ?? {}).sort().join(',') !== 'gitRemoteHtree,htree,nvpn') {
	throw new Error('v86 guest manifest has an incomplete binary set');
}
if (manifest.binaries.nvpn.bytes > 55 * 1024 * 1024) {
	throw new Error('WebVM nVPN binary includes features outside the minimal guest profile');
}

const actualArtifacts = {
	fsJson: await fileRecord(path.join(outputDirectory, 'fs.json')),
	rootfs: await treeRecord(path.join(outputDirectory, 'rootfs')),
	seabios: await fileRecord(path.join(outputDirectory, 'seabios.bin')),
	vgabios: await fileRecord(path.join(outputDirectory, 'vgabios.bin')),
};
for (const [name, actual] of Object.entries(actualArtifacts)) {
	if (JSON.stringify(manifest.artifacts?.[name]) !== JSON.stringify(actual)) {
		throw new Error(`v86 guest artifact ${name} is stale or modified; run npm run guest:build`);
	}
}

const stateDirectory = path.join(outputDirectory, 'state');
const stateManifestPath = path.join(stateDirectory, 'manifest.json');
let stateManifest;
try {
	stateManifest = JSON.parse(await readFile(stateManifestPath, 'utf8'));
} catch {
	throw new Error('Missing or invalid preinitialized v86 state; run npm run state:build');
}
const v86Package = JSON.parse(await readFile(path.join(root, 'node_modules/v86/package.json'), 'utf8'));
const guestManifestRecord = await fileRecord(manifestPath);
if (
	stateManifest.schema !== 1 ||
	stateManifest.encoding !== 'zstd' ||
	stateManifest.memoryBytes !== 96 * 1024 * 1024 ||
	stateManifest.v86Version !== v86Package.version ||
	stateManifest.guestManifestSha256 !== guestManifestRecord.sha256 ||
	!Array.isArray(stateManifest.chunks) ||
	stateManifest.chunks.length !== 1 ||
	stateManifest.bytes > 20 * 1024 * 1024
) {
	throw new Error('Preinitialized v86 state metadata is stale; run npm run state:build');
}
let stateBytes = 0;
for (const [index, chunk] of stateManifest.chunks.entries()) {
	const expectedFile = `state-${String(index).padStart(3, '0')}.bin`;
	if (chunk.file !== expectedFile) throw new Error('Preinitialized v86 state chunks are unordered');
	const actual = await fileRecord(path.join(stateDirectory, chunk.file));
	if (actual.bytes !== chunk.bytes || actual.sha256 !== chunk.sha256) {
		throw new Error(`Preinitialized v86 state chunk ${chunk.file} is stale or modified`);
	}
	stateBytes += actual.bytes;
}
if (stateBytes !== stateManifest.bytes) {
	throw new Error('Preinitialized v86 state size is inconsistent');
}
const expectedStateFiles = ['manifest.json', ...stateManifest.chunks.map((chunk) => chunk.file)].sort();
const actualStateFiles = (await readdir(stateDirectory)).sort();
if (JSON.stringify(actualStateFiles) !== JSON.stringify(expectedStateFiles)) {
	throw new Error('Preinitialized v86 state directory contains unexpected files');
}

function validSha256(value) {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validGitCommit(value) {
	return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}
