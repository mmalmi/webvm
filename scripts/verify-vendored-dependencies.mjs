import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.57',
		path: 'vendor/fips/fips-core-0.0.57.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.62/fips-core-0.0.57.tgz',
		sha256: 'd8a9fea417081e07aa94ab30a1d459fe2809c7cee64bff4be612c87364666a44',
		sha512: 'POUsLcusLEBc8gNXRrqP9FPYSUUbaxX3DzvtejEg6rNBaleVCPt3K445DUUj3p6J6vZDag+zolD4bZ9HFoxPHw==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.39',
		path: 'vendor/fips/fips-transport-ethernet-0.0.39.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.62/fips-transport-ethernet-0.0.39.tgz',
		sha256: '1af5b7bed31bb188c79ede368a4280480b45b3ae54896ef333b1a127f6f4ea28',
		sha512: '7F0NclbLfPfDFCcoejPKsYsi8epOGxnH1sZndx5g+KHeRxCif2ydoFwRG7Hl2x3cHJNsbm7qd8f50n/3BX6NRg==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.61',
		path: 'vendor/fips/fips-transport-webrtc-0.0.61.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.62/fips-transport-webrtc-0.0.61.tgz',
		sha256: '7ab7816c15275d4f6b5ac966365004d9fa2e2f94b7daeab309a93a28f4d3a325',
		sha512: '/peMttxBn/uvNfZjMxNf4IRHCs1SawCnIhu6XrGnyMc093acToT7C8R480eCPkNqRq8Q+QTD3J7CE4bR6Tz0OA==',
	},
	{
		name: '@fips/transport-websocket',
		version: '0.0.15',
		path: 'vendor/fips/fips-transport-websocket-0.0.15.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.62/fips-transport-websocket-0.0.15.tgz',
		sha256: '4877d41292eeb2deb0ebbd69cb7fabcadbda1ce7091048a17cfc603ffd854ab2',
		sha512: 'lIY8SHl7ebkQnIHH+kW3Dlh/E1HU1QU0rCs5oB2SneGRm+7fZ6uy8L9FFoJ6/QGwuBERmEetvkZAfBD89EXJyQ==',
	},
	{
		name: 'nostr-pubsub',
		version: '0.5.32',
		path: 'vendor/nostr-pubsub-0.5.32.tgz',
		url: 'https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.32/nostr-pubsub-0.5.32.tgz',
		sha256: '5b8b6a06e6ff51629afd434b3964d69474182bc7f6c9150ead404fa529c6f1ab',
		sha512: 'r4atGsees6cb2XOynyzN8/RzkiHmitRrsek3+J6WQ5zBAC8owa6krzgR0Vd3F7UUf7MRvyVh0to0/+eTmRi8+Q==',
	},
];
const APPROVED_REMOTE_PACKAGES = [
	{
		name: '@fips/tcp',
		version: '0.2.3',
		asset: 'fips-tcp-0.2.3.tgz',
		url: 'https://github.com/mmalmi/fips-tcp/releases/download/fips-tcp-v0.2.4/fips-tcp-0.2.3.tgz',
		sha256: '72fe87d554cffde23d2c34f779f3b8cebdca3f54f33878ca5e3b147a36681904',
		sha512: '0j7ucAgb7SFLkHHKMjJmR4v29psVmGoShiSgpba5IgJqAT/lJGTTKlHoAItKie+oNsiPGf/ww4YMuLTRYov2TA==',
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
