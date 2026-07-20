import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.29',
		path: 'vendor/fips/fips-core-0.0.29.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.29/fips-core-0.0.29.tgz',
		sha256: '86f7cb03706226f77d0ed305e2028b2bd487bf8436a197d8a95eb24115ee21a4',
		sha512: 'C5GN4Fj7D3X9riGaZwej9aoVsLG7TI8ar4RvT25Wmv+tiLsGWSY2Gn7wGAzYHqhhT7wVonc5cMjfs95qjdUwWQ==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.28',
		path: 'vendor/fips/fips-transport-ethernet-0.0.28.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.29/fips-transport-ethernet-0.0.28.tgz',
		sha256: '4bd17259604175d32ae6405d2b98aadbaf46c2ca846b015b8f45288b37986b27',
		sha512: 'q0HlAhVeezKKH3TpGh7b3mudhjp840JY9VC5yuy7mvqdd6H4KW+/Rvco4DbniTCDldfycyzDR/hHvWcQVrptbA==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.45',
		path: 'vendor/fips/fips-transport-webrtc-0.0.45.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.29/fips-transport-webrtc-0.0.45.tgz',
		sha256: '39317c9118d7a62f3dee191f1e815ef1a2a20e8b50ec5b2c37bc4627ae0d9b7c',
		sha512: 'aRonAlsJz56DlyBsc/IBMkKmKmrYuMuq24YLWbHfi8NmTphv6nOupWK3Tpd7DJphXgqCgKi2CnqW7PI6H2+bNw==',
	},
	{
		name: '@fips/transport-websocket',
		version: '0.0.3',
		path: 'vendor/fips/fips-transport-websocket-0.0.3.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.29/fips-transport-websocket-0.0.3.tgz',
		sha256: 'f3d45ab6be3146e6a06894e327641ce5904625fe8ce3346b260269d0d523c13e',
		sha512: '/K+DCBHoTyGtxEqjK4SquQ1Ua8hPjZokzQCmPtEJachd8CeQmDcmGUugRSWs9/FrVBwvfqi11DXs8eK+MZfp5Q==',
	},
	{
		name: 'nostr-pubsub',
		version: '0.5.1',
		path: 'vendor/nostr-pubsub-0.5.1.tgz',
		url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.1/nostr-pubsub-0.5.1.tgz',
		sha256: '48ea1c1cb37db84a5ba9efbb181f6ccd764ddaef42c39438995b6213aff1bd67',
		sha512: '8Du8STeYMT98zz00lo3uoETYeWpvVGZO3n0Xi9pZycXWPMxCQP1FwRgl0mrxTMT5KK1xOw4pMnpSGmMeVOidag==',
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
