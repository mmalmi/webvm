import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WEBVM_GUEST_TOOLS } from '../src/lib/webvmGuestTools.js';
import { gitRecord } from './v86-guest-manifest.mjs';
import { replaceGuestArtifacts } from './v86-guest-update.mjs';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = process.argv[2];
if (!inputPath) throw new Error('replace-v86-guest-tools requires a verified artifact JSON file');
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const names = Object.keys(input.binaries || {});
if (!names.length || names.some((name) => !Object.hasOwn(WEBVM_GUEST_TOOLS, name))) {
	throw new Error('Select only nvpn, htree, or gitRemoteHtree guest tools');
}
const requiredSources = new Set(['webvm', 'fips',
	...names.map((name) => name === 'nvpn' ? 'nvpn' : 'hashtree')]);
const sources = {};
for (const name of requiredSources) {
	const source = name === 'webvm' ? { repository: appDirectory } : input.sources?.[name];
	if (!source?.repository) throw new Error(`Missing ${name} source repository`);
	const actual = gitRecord(source.repository);
	if (actual.dirty || (name !== 'webvm' && actual.commit !== source.commit)) {
		throw new Error(`Expected clean ${name} source at the verified commit`);
	}
	sources[name] = actual;
}
const binaries = {};
for (const name of names) {
	const binary = input.binaries[name];
	if (!/^[0-9a-f]{64}$/u.test(binary.sha256 || '') || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(binary.version || '')) {
		throw new Error(`Missing verified ${name} hash or version`);
	}
	const data = await readFile(binary.path);
	if (createHash('sha256').update(data).digest('hex') !== binary.sha256) {
		throw new Error(`${name} does not match its verified artifact hash`);
	}
	const format = execFileSync('file', ['-b', binary.path], { encoding: 'utf8' }).trim();
	if (!format.includes('ELF 32-bit LSB') || !format.includes('Intel 80386') || !format.includes('statically linked')) {
		throw new Error(`${name} is not a static i386 ELF binary`);
	}
	binaries[name] = { data, version: binary.version, format };
}
const result = await replaceGuestArtifacts({
	guestDirectory: path.join(appDirectory, 'custom-disk-images/v86-guest'),
	backupParent: path.join(appDirectory, 'work/guest-tool-upgrades'),
	binaries, sources,
});
console.log(JSON.stringify(result, null, 2));
console.log('Recapture the identity-free guest state with npm run state:build before release.');
