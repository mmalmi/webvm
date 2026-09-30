import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.45',
		path: 'vendor/fips/fips-core-0.0.45.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.45/fips-core-0.0.45.tgz',
		sha256: '415c5fa20ea4d5c5df86e0a939dd275a391ac5bde8b416cd3699bc7f00691324',
		sha512: 'A+8esJMMdPcibpmVy30utUQFmv1tDVDdVJOD0oH5mZpFXAO9Gi/a5WjZea8P4PFnzea5lNJE8yBQF79LTvLyUQ==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.33',
		path: 'vendor/fips/fips-transport-ethernet-0.0.33.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.45/fips-transport-ethernet-0.0.33.tgz',
		sha256: '508b447a6e51c90cd187a2b8f86a5e2d786fb0737d082b0c8ad699ffedd4e4fc',
		sha512: '6qKk97SaavKFXSpoOomONW31843ZsB3x8l6IJAlkveGixngy3Jl2jMAqYG5P3Z5XOriVGxoLZLuhlqieQlQdEw==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.50',
		path: 'vendor/fips/fips-transport-webrtc-0.0.50.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.45/fips-transport-webrtc-0.0.50.tgz',
		sha256: 'c656355c3559e6667b2c963ac9733a77f0154a3999b9f567b460dacd76202322',
		sha512: 'q/9eqBc2hT/5ttodnTf0TM7ym+L/3quexfzHhCZuJUAqmf5/n41ES09YbeVX3orgmiJLKUvE+DMImfGM/RJObw==',
	},
	{
		name: '@fips/transport-websocket',
		version: '0.0.7',
		path: 'vendor/fips/fips-transport-websocket-0.0.7.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.45/fips-transport-websocket-0.0.7.tgz',
		sha256: '6503aa89c06cd5542480088c3a522abb04addf0c1cb1e675986a9ea8ffd8a9ae',
		sha512: 'v4f74Z0z0Wc4BbQMnRA5xGw9/6kmXIHDBee182bgDeSnCt4je4LH+QBt9x1zGpz64jW4YQNbhYLNoaqv1qQbcw==',
	},
	{
		name: 'nostr-pubsub',
		version: '0.5.13',
		path: 'vendor/nostr-pubsub-0.5.13.tgz',
		url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.13/nostr-pubsub-0.5.13.tgz',
		sha256: 'b061afb846f6d05ac75817b742e00d6b5c15c2a07aa6e28d464ba421e6f8c437',
		sha512: 'iL94fAtLDh5agPo/4qOgfy5QUmQL2GY/LFL4zp/H9U6St1+hJpLAcrA4eQLZlwyvtIXQu1tOtpdHkuhu4wEZ9A==',
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
