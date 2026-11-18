import { cp, mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEBVM_ROOTFS_PATH, shardedWebvmRootfsPath } from '../src/lib/webvmRootfsPath.js';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const [output] = process.argv.slice(2);
if (!output || process.argv.length !== 3) throw new Error('Usage: npm run stage:hashtree -- <new-directory>');

const stage = resolve(output);
const guestFiles = await readdir(resolve(build, `.${WEBVM_ROOTFS_PATH}`), { withFileTypes: true });
if (!guestFiles.length || guestFiles.some(file => !file.isFile() || !shardedWebvmRootfsPath(WEBVM_ROOTFS_PATH + file.name))) {
	throw new Error('The WebVM build is missing its content-addressed guest files');
}

await mkdir(stage);
await cp(build, stage, { recursive: true });
for (const { name } of guestFiles) {
	const flat = WEBVM_ROOTFS_PATH + name;
	const shard = resolve(stage, `.${shardedWebvmRootfsPath(flat)}`);
	await mkdir(dirname(shard), { recursive: true });
	await rename(resolve(stage, `.${flat}`), shard);
}
console.log(`Staged ${guestFiles.length} WebVM guest files for Hashtree.`);
