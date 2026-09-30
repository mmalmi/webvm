import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.44',
		path: 'vendor/fips/fips-core-0.0.44.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.44/fips-core-0.0.44.tgz',
		sha256: 'ae1ab2af519952d8cb10418a4ed52d1c324d084788a6fbda2515cb3ceb767a4b',
		sha512: '64RklKjkFFppkxxhLgCYjXNwuPhTPGV9WVg1nHPH1NljEkS1Bt3aZEhxIk20nE/dZDaWmbD47FGiofMSMWedxw==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.32',
		path: 'vendor/fips/fips-transport-ethernet-0.0.32.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.44/fips-transport-ethernet-0.0.32.tgz',
		sha256: '787c991d3434c9bb4ac51644df5cf8f2be240605696b9aa9af85c228f2c7535a',
		sha512: 'pQnTRyCjgz8fThqzue1ISsinJeJV74qlL6hlY5rzdL1QiG9CnS3vfQeKxqXGl0au1i4B/mKOjUpg7CoG4JIIbQ==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.49',
		path: 'vendor/fips/fips-transport-webrtc-0.0.49.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.44/fips-transport-webrtc-0.0.49.tgz',
		sha256: '28b88920c43c9a16de3c475ddf11eb0e73ef5cea6cf775e063b1d354ba77774c',
		sha512: 'iidNN5W89AQXzbssNuuae84gq7gJV09k6ZI6SbqqImuN5/6D3hi15/UVx2p3OLV5y+znpE0cIjB4Bew7oaFfzg==',
	},
	{
		name: '@fips/transport-websocket',
		version: '0.0.6',
		path: 'vendor/fips/fips-transport-websocket-0.0.6.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.44/fips-transport-websocket-0.0.6.tgz',
		sha256: '0d242010ad348c105a7d1bc17459fb7b4f8f5ebd293e57db53d4e2cbf9c96eb4',
		sha512: 'dzquYryja3/1rYdyIV2ohxrA6m/5U3bCDrJoEPg9tN9xIWzckntsHxSiqvFw221wYO4bUrRk1lIoVjDnheQ/1g==',
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
