import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_PATH = 'vendor/nostr-pubsub-0.1.4.tgz';
const PACKAGE_SPEC = `file:${PACKAGE_PATH}`;
const EXPECTED = {
	sha256: '676e101e71e71dc5b67d3f41d3a40576354abf9261b43020fd630dc92666dae7',
	sha512: 'Rm0e+UC1YBnjPjgHED0t+S6+ytUjz9l1ld1AiFiilpC2OU1HDZxtUUrJTjupoe97v6NUUhywkoNNLrZ9LHB9HA==',
};

async function readJson(file) {
	return JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
}

const [archive, manifest, lock] = await Promise.all([
	readFile(path.join(ROOT, PACKAGE_PATH)),
	readJson('package.json'),
	readJson('package-lock.json'),
]);
const locked = lock.packages?.['node_modules/nostr-pubsub'];
const actual = {
	sha256: createHash('sha256').update(archive).digest('hex'),
	sha512: createHash('sha512').update(archive).digest('base64'),
};
const failures = [];

if (manifest.dependencies?.['nostr-pubsub'] !== PACKAGE_SPEC) {
	failures.push(`package.json must pin nostr-pubsub to ${PACKAGE_SPEC}`);
}
if (lock.packages?.['']?.dependencies?.['nostr-pubsub'] !== PACKAGE_SPEC) {
	failures.push(`package-lock.json root must pin nostr-pubsub to ${PACKAGE_SPEC}`);
}
if (locked?.version !== '0.1.4' || locked?.resolved !== PACKAGE_SPEC) {
	failures.push('package-lock.json must resolve nostr-pubsub 0.1.4 from the vendored archive');
}
if (locked?.integrity !== `sha512-${EXPECTED.sha512}`) {
	failures.push('package-lock.json nostr-pubsub integrity does not match the approved archive');
}
for (const algorithm of Object.keys(EXPECTED)) {
	if (actual[algorithm] !== EXPECTED[algorithm]) {
		failures.push(`${PACKAGE_PATH} ${algorithm} does not match the approved archive`);
	}
}

if (failures.length > 0) {
	console.error(`Vendored dependency verification failed:\n${failures.map((item) => `- ${item}`).join('\n')}`);
	process.exit(1);
}
console.log(`Verified nostr-pubsub 0.1.4 (${actual.sha256}).`);
