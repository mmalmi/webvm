import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.31',
		path: 'vendor/fips/fips-core-0.0.31.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.31/fips-core-0.0.31.tgz',
		sha256: '11d46516e254ae8e03fb3e1cf42512d29d1813cce70551b548223a1bc420d514',
		sha512: 'WteYHt8rgOGyvJTVbQt6IWiahK5GD1r31rq415l1Unk8gqVfncT/Mi1Jxm8n9v7cCdjKzh1GuBSYLe3x6NB6FA==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.30',
		path: 'vendor/fips/fips-transport-ethernet-0.0.30.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.31/fips-transport-ethernet-0.0.30.tgz',
		sha256: '5079153889d8c2fc0f34110364ccb96d0cc4219d5fbd748bc61469908bd9aec4',
		sha512: 'HV5p7wVW7tkYAiqZk/GbqUrshgvIHRA6MraHffTZAeMigEWlg0T0WIgiQT6dSaM5mahykKYkqiVndqs/Xahz4A==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.47',
		path: 'vendor/fips/fips-transport-webrtc-0.0.47.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.31/fips-transport-webrtc-0.0.47.tgz',
		sha256: 'b7fc538c693382932367d09881de0b7201d23a8b0d0b046e89690c1a4f8366d1',
		sha512: '2PngOs3tjO2JOQYdh4MbDkgawtZ5n2hry/pTDFnz3NiLAMjGns3d7g4XwewrTnVWv4hhTVNMEx3YdhF1Qvf2qw==',
	},
	{
		name: '@fips/transport-websocket',
		version: '0.0.5',
		path: 'vendor/fips/fips-transport-websocket-0.0.5.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.31/fips-transport-websocket-0.0.5.tgz',
		sha256: 'c56ee58ffc45913dad4380e421446b2613824d143af97d3da1d388b667ed116a',
		sha512: 'Qj641P/xa7CQpcVQl52u5PgftzGPtGHIva9mpXRcNgdteB5LlTdCA7/GBfRKtuSxGoNaRi1iKHH4fBHitNe30A==',
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
