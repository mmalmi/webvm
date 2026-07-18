import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.27',
		path: 'vendor/fips/fips-core-0.0.27.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.27/fips-core-0.0.27.tgz',
		sha256: '9c9b5baa4b43f96e6e3b151d62cc58d15c5878384112e1e4f69ca0caa6943f20',
		sha512: '/BID3NU94sfrpPgILlTFA3ERX4TfLbtvaajhnkoMV5X/e2Mo1EhBKE/uVkYhpe434ADLKvDGpCMWW6mgU6ymSQ==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.26',
		path: 'vendor/fips/fips-transport-ethernet-0.0.26.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.27/fips-transport-ethernet-0.0.26.tgz',
		sha256: '14f381a9f742bf357a7a5a4faaf4b58ed8f945facfe7bf0c61bb73912d96e282',
		sha512: 'vZrYhpwQPzC2sOgvJ2Gljhve8aRV48oES5VmtFw0malersiqmG900ngf7aw+RcareZdtdmY1IRfM2AMyO5xJrg==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.43',
		path: 'vendor/fips/fips-transport-webrtc-0.0.43.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.27/fips-transport-webrtc-0.0.43.tgz',
		sha256: '8504bbea239db7eb719c059204e4b70776be6a755ead37b83ec08a6259a24f2e',
		sha512: '9VcYbP85Km7NY5C+I+Hqk9Qu02NNP4SSSje9z3hqF2kSLU4UP6iDdX7dlawRj4JUqYT97ZX2HbAu6avtbsxOdg==',
	},
	{
		name: '@fips/transport-websocket',
		version: '0.0.1',
		path: 'vendor/fips/fips-transport-websocket-0.0.1.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.27/fips-transport-websocket-0.0.1.tgz',
		sha256: '8601d16bfd5f4ab851b86eb5206ca3a713262e22584ba26c81e10635dd270b19',
		sha512: 'R8vh0bIwFW0K1GrvJc8Woq/z40BRd4B0A4iDA+/GQwm9FIAzrZVSaPGCt+4xNX+t5gyraP3j3/kA1a/mGa4VbQ==',
	},
	{
		name: 'nostr-pubsub',
		version: '0.3.1',
		path: 'vendor/nostr-pubsub-0.3.1.tgz',
		url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.3.1/nostr-pubsub-0.3.1.tgz',
		sha256: 'ae7a8636cf05ba5787a3a452e80fa77b2c9ee273d64043aadb4f35fa9a0c6404',
		sha512: 'hXw3ON9MSNgQc0/t4kl46yBIvTZPZWpCeR4QMOyr7FXJAKLW2qtenRMRQczO7lnTdlYbsN7+/eMtL/fQ/6wVRA==',
	},
];
const APPROVED_REMOTE_PACKAGES = [
	{
		name: '@fips/tcp',
		version: '0.2.0',
		asset: 'fips-tcp-0.2.0.tgz',
		url: 'https://github.com/mmalmi/fips-tcp/releases/download/v0.2.0/fips-tcp-0.2.0.tgz',
		sha256: '0df4dae9aaa388752636c867b27384881aa62e04fb74e67cb48fae04d35c1d05',
		sha512: 'KCJmltpx4cH76Sp+GOKJvYzQpwUTUtmyBA5bgcfS36ty8AxSgBQZxLdBwM59IER+B/rZpjRYFtqE6MPePL0o+w==',
	},
];

function digests(bytes) {
	return {
		sha256: createHash('sha256').update(bytes).digest('hex'),
		sha512: createHash('sha512').update(bytes).digest('base64'),
	};
}

async function readJson(file) {
	return JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
}

const [manifest, lock] = await Promise.all([
	readJson('package.json'),
	readJson('package-lock.json'),
]);
const failures = [];
const approvedPaths = new Set(APPROVED_PACKAGES.map(({ path: archivePath }) => archivePath));
const vendoredPaths = [];
for (const directory of ['vendor', 'vendor/fips']) {
	for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith('.tgz')) {
			vendoredPaths.push(path.posix.join(directory, entry.name));
		}
	}
}
for (const archivePath of vendoredPaths) {
	if (!approvedPaths.has(archivePath)) failures.push(`unapproved vendored archive: ${archivePath}`);
}

for (const approved of APPROVED_PACKAGES) {
	const archive = await readFile(path.join(ROOT, approved.path));
	const packageSpec = `file:${approved.path}`;
	const locked = lock.packages?.[`node_modules/${approved.name}`];
	const actual = digests(archive);
	const source = new URL(approved.url);
	if (source.protocol !== 'https:'
		|| source.hostname !== 'github.com'
		|| !source.pathname.includes('/releases/download/')
		|| path.posix.basename(source.pathname) !== path.basename(approved.path)) {
		failures.push(`${approved.name} source URL is not an immutable matching release asset`);
	}

	if (manifest.dependencies?.[approved.name] !== packageSpec) {
		failures.push(`package.json must pin ${approved.name} to ${packageSpec}`);
	}
	if (lock.packages?.['']?.dependencies?.[approved.name] !== packageSpec) {
		failures.push(`package-lock.json root must pin ${approved.name} to ${packageSpec}`);
	}
	if (locked?.version !== approved.version || locked?.resolved !== packageSpec) {
		failures.push(
			`package-lock.json must resolve ${approved.name} ${approved.version} from the vendored archive`,
		);
	}
	if (locked?.integrity !== `sha512-${approved.sha512}`) {
		failures.push(`package-lock.json ${approved.name} integrity does not match the approved archive`);
	}
	for (const algorithm of ['sha256', 'sha512']) {
		if (actual[algorithm] !== approved[algorithm]) {
			failures.push(`${approved.path} ${algorithm} does not match the approved archive`);
		}
	}
	if (process.env.VERIFY_VENDORED_REMOTE === '1') {
		const response = await fetch(approved.url, { redirect: 'follow' });
		if (!response.ok) {
			failures.push(`${approved.name} source download failed: HTTP ${response.status}`);
		} else {
			const remote = digests(new Uint8Array(await response.arrayBuffer()));
			for (const algorithm of ['sha256', 'sha512']) {
				if (remote[algorithm] !== approved[algorithm]) {
					failures.push(`${approved.name} source ${algorithm} does not match the approved archive`);
				}
			}
		}
	}
	console.log(`Verified ${approved.name} ${approved.version} (${actual.sha256}).`);
}

for (const approved of APPROVED_REMOTE_PACKAGES) {
	const locked = lock.packages?.[`node_modules/${approved.name}`];
	const source = new URL(approved.url);
	if (source.protocol !== 'https:'
		|| source.hostname !== 'github.com'
		|| !source.pathname.includes('/releases/download/')
		|| path.posix.basename(source.pathname) !== approved.asset) {
		failures.push(`${approved.name} source URL is not an immutable matching release asset`);
	}
	if (manifest.dependencies?.[approved.name] !== approved.url) {
		failures.push(`package.json must pin ${approved.name} to ${approved.url}`);
	}
	if (lock.packages?.['']?.dependencies?.[approved.name] !== approved.url) {
		failures.push(`package-lock.json root must pin ${approved.name} to ${approved.url}`);
	}
	if (locked?.version !== approved.version || locked?.resolved !== approved.url) {
		failures.push(
			`package-lock.json must resolve ${approved.name} ${approved.version} from its release asset`,
		);
	}
	if (locked?.integrity !== `sha512-${approved.sha512}`) {
		failures.push(`package-lock.json ${approved.name} integrity does not match the approved archive`);
	}
	if (process.env.VERIFY_VENDORED_REMOTE === '1') {
		const response = await fetch(approved.url, { redirect: 'follow' });
		if (!response.ok) {
			failures.push(`${approved.name} source download failed: HTTP ${response.status}`);
		} else {
			const remote = digests(new Uint8Array(await response.arrayBuffer()));
			for (const algorithm of ['sha256', 'sha512']) {
				if (remote[algorithm] !== approved[algorithm]) {
					failures.push(`${approved.name} source ${algorithm} does not match the approved archive`);
				}
			}
		}
	}
	console.log(`Verified ${approved.name} ${approved.version} (${approved.sha256}).`);
}

if (failures.length > 0) {
	console.error(
		`Vendored dependency verification failed:\n${failures.map((item) => `- ${item}`).join('\n')}`,
	);
	process.exit(1);
}
