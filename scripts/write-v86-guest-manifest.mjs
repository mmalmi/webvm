import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	GUEST_MANIFEST_SCHEMA,
	fileRecord,
	gitRecord,
	treeRecord,
} from './v86-guest-manifest.mjs';

const [
	outputDirectory,
	nvpnBinary,
	htreeBinary,
	gitRemoteHtreeBinary,
	image,
	webvmRepository,
	nvpnRepository,
	hashtreeRepository,
	fipsRepository,
	v86Repository,
] = process.argv.slice(2);

if (!v86Repository) {
	throw new Error('write-v86-guest-manifest requires guest artifacts, binaries, image, and source repositories');
}

const sourceRepositories = {
	webvm: webvmRepository,
	nvpn: nvpnRepository,
	hashtree: hashtreeRepository,
	fips: fipsRepository,
	v86: v86Repository,
};
const sources = Object.fromEntries(
	Object.entries(sourceRepositories).map(([name, repository]) => [name, gitRecord(repository)]),
);
const dirtySources = Object.entries(sources)
	.filter(([, source]) => source.dirty)
	.map(([name]) => name);
if (dirtySources.length > 0) {
	throw new Error(`Refusing to attest guest built from dirty sources: ${dirtySources.join(', ')}`);
}

const dockerfile = await readFile(path.join(webvmRepository, 'dockerfiles/v86_guest'), 'utf8');
const baseImage = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
if (!baseImage?.startsWith('i386/alpine:3.22@sha256:')) {
	throw new Error('Guest base image must be a digest-pinned i386 Alpine 3.22 image');
}

const imageInspection = JSON.parse(
	execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }),
)[0];
if (imageInspection.Architecture !== '386') {
	throw new Error(`Guest container image architecture is ${imageInspection.Architecture}, expected 386`);
}

const binaryPaths = {
	nvpn: nvpnBinary,
	htree: htreeBinary,
	gitRemoteHtree: gitRemoteHtreeBinary,
};
const binaries = {};
for (const [name, binaryPath] of Object.entries(binaryPaths)) {
	const description = execFileSync('file', ['-b', binaryPath], { encoding: 'utf8' }).trim();
	if (!description.includes('ELF 32-bit LSB') || !description.includes('Intel 80386')) {
		throw new Error(`${name} is not an i386 ELF binary: ${description}`);
	}
	binaries[name] = {
		...(await fileRecord(binaryPath)),
		format: description,
	};
}

const artifacts = {
	fsJson: await fileRecord(path.join(outputDirectory, 'fs.json')),
	rootfs: await treeRecord(path.join(outputDirectory, 'rootfs')),
	seabios: await fileRecord(path.join(outputDirectory, 'seabios.bin')),
	vgabios: await fileRecord(path.join(outputDirectory, 'vgabios.bin')),
};

const manifest = {
	schema: GUEST_MANIFEST_SCHEMA,
	baseImage,
	containerImage: {
		id: imageInspection.Id,
		architecture: imageInspection.Architecture,
	},
	sources,
	binaries,
	artifacts,
};

await writeFile(
	path.join(outputDirectory, 'manifest.json'),
	`${JSON.stringify(manifest, null, 2)}\n`,
	{ mode: 0o644 },
);
