import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.26',
		path: 'vendor/fips/fips-core-0.0.26.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.26/fips-core-0.0.26.tgz',
		sha256: '826b70c51f0f1126188240b274f3fbee3a8b348238663b145bae5013ddc583e9',
		sha512: 'plDWMSHjjVyH4BnkO4GgZcvpgIV6LTFspcWF1Gg0LE7sI+dAsqHP+OfAP6VKBh91QX6SSvJ2G4TJI28nfbNsLA==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.25',
		path: 'vendor/fips/fips-transport-ethernet-0.0.25.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.26/fips-transport-ethernet-0.0.25.tgz',
		sha256: '73ccc4ad6dbb29287d71838439e7e6e472b5d7215129f280e851b455b7e541d8',
		sha512: 'tOjPMyX3+kNQrzYsFAYuSsY1uPzuMaCcBzAsymb+2XoQH0C6N3UkR4z0I3d/kh3lKriXNhUn4SYuQ+a3LISBIA==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.42',
		path: 'vendor/fips/fips-transport-webrtc-0.0.42.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.26/fips-transport-webrtc-0.0.42.tgz',
		sha256: '7523190710785977a6800ddb0bcc099210f71f0bd4c208b64a97180ed1e2cb33',
		sha512: 'vqbMj4mgJdS5sAXYLe4kb9B3ZtdnNFsQof3y0W2vF4TruccMH48AmxY+J6gOKCwhOHkFFgJ9V/4m1MVKzLsIiw==',
	},
	{
		name: 'nostr-pubsub',
		version: '0.3.0',
		path: 'vendor/nostr-pubsub-0.3.0.tgz',
		url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.3.0/nostr-pubsub-0.3.0.tgz',
		sha256: '1243ed3863ae1123b0f690bcf26e3d4fdf5a5436f8cba31202cb7b1a57a3b3c5',
		sha512: 'ApsAMv4jaHtff8cIcDoRjPF+RpZ6cn2IFPl0iMYvliXJd/5Dtz9umh6uRHSjFvkVlCNUCyEgQ2p5IEOKRd+Mpw==',
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

if (failures.length > 0) {
	console.error(
		`Vendored dependency verification failed:\n${failures.map((item) => `- ${item}`).join('\n')}`,
	);
	process.exit(1);
}
