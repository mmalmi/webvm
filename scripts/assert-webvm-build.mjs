import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
	'build/v86/v86.wasm',
	'build/v86/seabios.bin',
	'build/v86/vgabios.bin',
	'build/v86/guest/fs.json',
	'build/v86/guest/manifest.json',
	'build/v86/guest/state/manifest.json',
];

for (const file of required) {
	if (!(await stat(path.join(root, file))).isFile()) {
		throw new Error(`WebVM build artifact is missing: ${file}`);
	}
}
if (!(await stat(path.join(root, 'build/v86/guest/rootfs'))).isDirectory()) {
	throw new Error('WebVM build rootfs directory is missing');
}

console.log(`Verified ${required.length + 1} WebVM build asset paths.`);
