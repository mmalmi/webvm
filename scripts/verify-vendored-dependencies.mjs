import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: '@fips/core',
		version: '0.0.28',
		path: 'vendor/fips/fips-core-0.0.28.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.28/fips-core-0.0.28.tgz',
		sha256: '81e6d692118c1b75ca2b85f6b1b9a574e6b97b812667a36fdf0d1444fa6f3a4e',
		sha512: 'LXAi4T8ba1Qug0vwmhrS0w7kjHURJozsWY62eKq6jzYNJo42xhBI1d1Vlg2s1yGsMt0LvjEZaimnylYAZldsKQ==',
	},
	{
		name: '@fips/transport-ethernet',
		version: '0.0.27',
		path: 'vendor/fips/fips-transport-ethernet-0.0.27.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.28/fips-transport-ethernet-0.0.27.tgz',
		sha256: 'c9c7f5093d247492e005fad6af170989064c3b7fb226c29661c233059949a903',
		sha512: 'd1tjqrodX05w+KVpmdHSHI/JvcZcE461Gfg9/F9TbVp6yOtyWazdqTQDq9LYmbmZeOupub9UdzWtYzPd2Su+4Q==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.44',
		path: 'vendor/fips/fips-transport-webrtc-0.0.44.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.28/fips-transport-webrtc-0.0.44.tgz',
		sha256: 'c5d501d438c49dd3f4b3d4ec7a4f1660e769d94eedf72c8ae3d3d30e8777df2f',
		sha512: 'XRdHoG+BbpCp2T66kJk3TZP5r/qhx/BI3y4hJKrU3QomuCNLB1P6VNJqYq+Mmli2Nz/MAQeyiw55xcHzhOATEw==',
	},
	{
		name: '@fips/transport-websocket',
		version: '0.0.2',
		path: 'vendor/fips/fips-transport-websocket-0.0.2.tgz',
		url: 'https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.28/fips-transport-websocket-0.0.2.tgz',
		sha256: 'fbcda63cc758589bc253ae595097133f183ae6c9f7d4feb8641d496070cc310b',
		sha512: 'yCO2v9VG5z/9845wzxMMdxoaKv11qPpPKxJqQKk7LktxhD8cqtA+YhVLkjQiDt0Fau+QVHx5nNwc/iIMHGhh9Q==',
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
