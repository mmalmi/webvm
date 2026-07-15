import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_PACKAGES = [
	{
		name: 'nostr-pubsub',
		version: '0.1.5',
		path: 'vendor/nostr-pubsub-0.1.5.tgz',
		sha256: '0c9cb7ec3ae0acbf516881ec76cc14f4f623ee0be5619494f38cce62aafe72b7',
		sha512: 'zza+r1FWKMopO4XUxLD0GfnBvUOpNju9Pr4nKCZ8np8xqo0sKDaCcbM/VvZmjNd2/iHdtyducpkrmAXnqUt+9w==',
	},
	{
		name: '@fips/transport-webrtc',
		version: '0.0.39',
		path: 'vendor/fips/fips-transport-webrtc-0.0.39.tgz',
		sha256: '3622b7915e71836345f6f2791d7acf237bdf9daba8ce1c39abfcd7b2da939e68',
		sha512: 'cROw8rdGxBlVvyGBeXlP4KZGlQV2NnXBbjuaUJjBUIiAVqcwHQMdxtDLoWnN84A14puREgSisxkg95RMasg+Mg==',
	},
];

async function readJson(file) {
	return JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
}

const [manifest, lock] = await Promise.all([
	readJson('package.json'),
	readJson('package-lock.json'),
]);
const failures = [];

for (const approved of APPROVED_PACKAGES) {
	const archive = await readFile(path.join(ROOT, approved.path));
	const packageSpec = `file:${approved.path}`;
	const locked = lock.packages?.[`node_modules/${approved.name}`];
	const actual = {
		sha256: createHash('sha256').update(archive).digest('hex'),
		sha512: createHash('sha512').update(archive).digest('base64'),
	};

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
	console.log(`Verified ${approved.name} ${approved.version} (${actual.sha256}).`);
}

if (failures.length > 0) {
	console.error(
		`Vendored dependency verification failed:\n${failures.map((item) => `- ${item}`).join('\n')}`,
	);
	process.exit(1);
}
