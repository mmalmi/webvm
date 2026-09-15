import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { chromium } from '@playwright/test';
import { preview as startPreview } from 'vite';
import { WEBVM_MEMORY_BYTES } from '../src/lib/webvmGuestConfig.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'custom-disk-images/v86-guest/state');
const guestManifestPath = path.join(root, 'custom-disk-images/v86-guest/manifest.json');
const port = Number(process.env.WEBVM_STATE_PORT || 4175);
const baseUrl = `http://127.0.0.1:${port}`;
const chunkBytes = 20 * 1024 * 1024;
const snapshotReadyMarker = '__IRIS_SNAPSHOT_READY__';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: root,
			stdio: options.stdio || 'inherit',
			...options,
		});
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (signal) reject(new Error(`${command} was interrupted by ${signal}`));
			else if (code !== 0) reject(new Error(`${command} exited with status ${code}`));
			else resolve();
		});
	});
}

async function captureState(downloadPath) {
	const preview = await startPreview({
		root,
		preview: { host: '127.0.0.1', port, strictPort: true },
	});
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ acceptDownloads: true });
		const page = await context.newPage();
		await page.goto(`${baseUrl}/v86?cold-boot&snapshot-build`, {
			waitUntil: 'domcontentloaded',
			timeout: 120_000,
		});
		await page.waitForFunction(
			() => globalThis.irisWebvmV86?.state?.().terminalReady === true,
			null,
			{ timeout: 120_000 },
		);

		await page.evaluate(() => {
			globalThis.irisWebvmV86.emulator.serial0_send(
				"stty -echo; " +
				"! rc-status default 2>/dev/null | grep -Eq 'webvm-(hashtree|nvpn)' && " +
				"test ! -e /var/lib/hashtree/config/keys && " +
				"test ! -e /var/lib/hashtree/config/auth.cookie && " +
				"test -z \"$(find /var/lib/nvpn /var/lib/hashtree/data -type f -print -quit)\" && " +
				"sync && echo 3 > /proc/sys/vm/drop_caches && " +
				"scrub_mib=$(awk '/^MemAvailable:/ {print int($2/1024)-16}' /proc/meminfo) && " +
				"test \"$scrub_mib\" -gt 0 && " +
				"mkdir -p /run/webvm-snapshot-scrub && " +
				"mount -t tmpfs -o size=${scrub_mib}m tmpfs /run/webvm-snapshot-scrub && " +
				"dd if=/dev/zero of=/run/webvm-snapshot-scrub/zero bs=1M count=\"$scrub_mib\" >/dev/null 2>&1 && " +
				"rm /run/webvm-snapshot-scrub/zero && " +
				"umount /run/webvm-snapshot-scrub && rmdir /run/webvm-snapshot-scrub && " +
				"sync && echo 3 > /proc/sys/vm/drop_caches " +
				"|| { echo __IRIS_SNAPSHOT_FAILED__; exit 1; }; " +
				"history -c >/dev/null 2>&1; rm -f /root/.ash_history; " +
				"exec /bin/ash -c \"printf '__IRIS_SNAPSHOT_%s__\\n' READY; exec /bin/ash\"\n",
			);
		});
		await page.waitForFunction(
			(marker) => {
				const terminal = globalThis.irisWebvmV86?.serialTerminal;
				const buffer = terminal?.buffer?.active;
				if (!buffer) return false;
				let markerSeen = false;
				for (let row = Math.max(0, buffer.length - 40); row < buffer.length; row += 1) {
					const line = buffer.getLine(row)?.translateToString(true) || '';
					if (line.includes(marker)) markerSeen = true;
					else if (markerSeen && line.includes('root@webvm:~#')) return true;
				}
				return false;
			},
			snapshotReadyMarker,
			{ timeout: 30_000 },
		);

		const [download] = await Promise.all([
			page.waitForEvent('download', { timeout: 120_000 }),
			page.evaluate(async () => {
				const state = await globalThis.irisWebvmV86.emulator.save_state();
				const url = URL.createObjectURL(new Blob([state]));
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.download = 'iris-webvm-state.bin';
				anchor.click();
				setTimeout(() => URL.revokeObjectURL(url), 1_000);
			}),
		]);
		await download.saveAs(downloadPath);
	} finally {
		await browser?.close();
		await preview.close();
	}
}

async function main() {
	await mkdir(outputDirectory, { recursive: true });
	await writeFile(
		path.join(outputDirectory, 'snapshot-build-bootstrap.json'),
		'{"snapshotBuild":true}\n',
	);
	await run('npx', ['vite', 'build']);
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'iris-webvm-state-'));
	const statePath = path.join(temporaryDirectory, 'state.bin');
	const compressedStatePath = path.join(temporaryDirectory, 'state.bin.zst');
	try {
		await captureState(statePath);
		const capturedState = await readFile(statePath);
		const metadataBytes = capturedState.readUInt32LE(12);
		const metadata = JSON.parse(capturedState.subarray(16, 16 + metadataBytes).toString());
		if (metadata.state?.[0] !== WEBVM_MEMORY_BYTES) {
			throw new Error('Captured WebVM memory does not match the configured guest memory');
		}
		// Keep the larger guest within the existing single-chunk download budget.
		await run('zstd', [
			'-19',
			'--no-progress',
			'--force',
			statePath,
			'-o',
			compressedStatePath,
		]);
		const [state, guestManifest, v86Package] = await Promise.all([
			readFile(compressedStatePath),
			readFile(guestManifestPath),
			readFile(path.join(root, 'node_modules/v86/package.json'), 'utf8').then(JSON.parse),
		]);
		await rm(outputDirectory, { recursive: true, force: true });
		await mkdir(outputDirectory, { recursive: true });

		const chunks = [];
		for (let offset = 0, index = 0; offset < state.length; offset += chunkBytes, index += 1) {
			const bytes = state.subarray(offset, Math.min(state.length, offset + chunkBytes));
			const file = `state-${String(index).padStart(3, '0')}.bin`;
			await writeFile(path.join(outputDirectory, file), bytes);
			chunks.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
		}

		const manifest = {
			schema: 1,
			encoding: 'zstd',
			createdAt: new Date().toISOString(),
			bytes: state.length,
			memoryBytes: WEBVM_MEMORY_BYTES,
			v86Version: v86Package.version,
			guestManifestSha256: sha256(guestManifest),
			chunks,
		};
		await writeFile(
			path.join(outputDirectory, 'manifest.json'),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		console.log(`${outputDirectory} (${state.length} bytes in ${chunks.length} chunks)`);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
