import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	GUEST_MANIFEST_SCHEMA,
	fileRecord,
	gitCommit,
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

const repositories = {
	webvm: root,
	nvpn: process.env.NVPN_REPO_PATH ?? path.resolve(root, '../nostr-vpn'),
	hashtree: process.env.HASHTREE_REPO_PATH ?? path.resolve(root, '../hashtree'),
	fips: process.env.FIPS_REPO_PATH ?? path.resolve(root, '../fips'),
	v86: process.env.V86_REPO_PATH ?? path.resolve(root, '../v86'),
};
for (const [name, repository] of Object.entries(repositories)) {
	const source = manifest.sources?.[name];
	if (!source || source.dirty !== false) {
		throw new Error(`v86 guest source ${name} was not attested clean`);
	}
	const commit = gitCommit(repository);
	if (source.commit !== commit) {
		throw new Error(`v86 guest source ${name} changed; run npm run guest:build`);
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

function validSha256(value) {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
