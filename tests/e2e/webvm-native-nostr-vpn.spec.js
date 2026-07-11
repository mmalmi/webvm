import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readBarcodes } from 'zxing-wasm/reader';

const REAL_E2E_ENABLED = process.env.NVPN_WEBVM_REAL_E2E === '1';
const SERIAL_BUFFER_LIMIT = 128 * 1024;

test.skip(!REAL_E2E_ENABLED, 'set NVPN_WEBVM_REAL_E2E=1 to run the real join-request e2e');
test.use({ trace: 'off', viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 2 });

function nvpnBinary() {
	const binary = path.resolve(
		process.env.NVPN_WEBVM_NVPN_BIN?.trim()
			|| path.join(process.cwd(), '../nostr-vpn/target/debug/nvpn'),
	);
	if (!existsSync(binary) || !statSync(binary).isFile()) {
		throw new Error(`nVPN binary is unavailable: ${binary}`);
	}
	return binary;
}

function createIsolatedAdmin(nvpn) {
	const directory = mkdtempSync(path.join(tmpdir(), 'iris-webvm-nvpn-e2e-'));
	const configPath = path.join(directory, 'admin.toml');
	execFileSync(nvpn, ['init', '--force', '--config', configPath], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	return {
		configPath,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

function startAdminHelper({ configPath, nvpn }) {
	const manifest = path.resolve(
		process.env.NVPN_APP_CORE_MANIFEST?.trim()
			|| path.join(process.cwd(), '../nostr-vpn/crates/nostr-vpn-app-core/Cargo.toml'),
	);
	const child = spawn(process.env.CARGO || 'cargo', [
		'run',
		'--quiet',
		'--manifest-path',
		manifest,
		'--example',
		'webvm_native_fips_e2e',
		'--',
		'--config-path',
		configPath,
		'--nvpn-bin',
		nvpn,
	], {
		cwd: path.dirname(manifest),
		env: { ...process.env, NVPN_WEBVM_REAL_E2E: '1', RUST_LOG: 'off' },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	const events = [];
	child.stdout.on('data', (chunk) => {
		stdout += chunk.toString();
		for (;;) {
			const newline = stdout.indexOf('\n');
			if (newline < 0) break;
			const line = stdout.slice(0, newline).trim();
			stdout = stdout.slice(newline + 1);
			if (line) events.push(JSON.parse(line));
		}
	});
	child.stderr.on('data', (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-8_000);
	});

	async function waitForStatus(status, timeoutMs = 120_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const error = events.find((event) => event.status === 'error');
			if (error) throw new Error(`admin helper failed: ${JSON.stringify(error)} ${stderr}`);
			const event = events.find((candidate) => candidate.status === status);
			if (event) return event;
			if (child.exitCode !== null) {
				throw new Error(`admin helper exited ${child.exitCode}: ${stderr}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`timed out waiting for admin helper status ${status}: ${stderr}`);
	}

	function writeLine(line) {
		child.stdin.write(`${line}\n`);
	}

	return {
		waitForStatus,
		async approve(request) {
			await waitForStatus('ready');
			writeLine(`import ${request}`);
			return waitForStatus('imported');
		},
		async cleanup() {
			if (child.exitCode !== null) return;
			writeLine('cleanup');
			await waitForStatus('cleaned');
			child.stdin.end();
		},
		stop() {
			if (child.exitCode === null) child.kill('SIGTERM');
		},
	};
}

async function waitUntil(check, { timeoutMs, message, intervalMs = 100 }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(message);
}

async function attachSerial(page) {
	await waitUntil(
		() => page.evaluate(() => Boolean(globalThis.irisWebvmV86?.emulator?.serial0_send)),
		{ timeoutMs: 120_000, message: 'v86 serial port did not become ready' },
	);
	await page.evaluate((limit) => {
		const emulator = globalThis.irisWebvmV86.emulator;
		const serial = { text: '', decoder: new TextDecoder(), emulator };
		serial.onByte = (byte) => {
			serial.text += serial.decoder.decode(Uint8Array.of(byte & 0xff), { stream: true });
			if (serial.text.length > limit) serial.text = serial.text.slice(-limit);
		};
		emulator.add_listener('serial0-output-byte', serial.onByte);
		globalThis.__nvpnJoinE2eSerial = serial;
	}, SERIAL_BUFFER_LIMIT);
}

async function normalizeQrScreenshot(page, screenshot, verticalScale) {
	const encodedPng = screenshot.toString('base64');
	const normalized = await page.evaluate(async ({ encodedPng: encoded, scaleY }) => {
		const image = new Image();
		image.src = `data:image/png;base64,${encoded}`;
		await new Promise((resolve, reject) => {
			image.onload = resolve;
			image.onerror = reject;
		});
		const border = 32;
		const canvas = document.createElement('canvas');
		canvas.width = image.width + border * 2;
		canvas.height = Math.round(image.height * scaleY) + border * 2;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.imageSmoothingEnabled = false;
		context.drawImage(image, border, border, image.width, canvas.height - border * 2);
		return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
	}, { encodedPng, scaleY: verticalScale });
	return Buffer.from(normalized, 'base64');
}

async function decodeQr(screenshot) {
	for (const binarizer of ['LocalAverage', 'GlobalHistogram']) {
		const results = await readBarcodes(new Uint8Array(screenshot), {
			formats: ['QRCode'],
			tryHarder: true,
			tryDenoise: true,
			binarizer,
		});
		const decoded = results.find((result) => result.text?.startsWith('nvpn://join-request/'));
		if (decoded) return decoded.text;
	}
	throw new Error('terminal join-request QR could not be decoded');
}

async function startAndScanJoinRequest(page) {
	const endMarker = '__NVPN_JOIN_REQUEST_ACCEPTED__';
	await page.evaluate((marker) => {
		const terminal = globalThis.irisWebvmV86.serialTerminal;
		const consoleElement = document.querySelector('[data-testid="v86-serial"]');
		Object.assign(consoleElement.style, { width: '1440px', height: '1240px' });
		terminal.resize(150, 76);
		terminal.reset();
		globalThis.__nvpnJoinE2eSerial.text = '';
		globalThis.__nvpnJoinE2eSerial.emulator.serial0_send(
			`nvpn join-request; printf '\\n${marker}\\n'\n`,
		);
	}, endMarker);
	await waitUntil(
		() => page.evaluate(() => (
			globalThis.__nvpnJoinE2eSerial?.text || ''
		).includes('nvpn://join-request/')),
		{ timeoutMs: 60_000, message: 'join-request link did not render' },
	);
	await page.waitForTimeout(300);
	const geometry = await page.evaluate(() => {
		const terminal = globalThis.irisWebvmV86.serialTerminal;
		const buffer = terminal.buffer.active;
		const screen = document.querySelector('[data-testid="v86-serial"] .xterm-screen');
		let firstRow = Infinity;
		let lastRow = -1;
		let firstColumn = Infinity;
		let lastColumn = -1;
		for (let row = buffer.viewportY; row < buffer.length; row += 1) {
			const line = buffer.getLine(row)?.translateToString(true) || '';
			for (let column = 0; column < line.length; column += 1) {
				if (!/[▀▄█]/u.test(line[column])) continue;
				firstRow = Math.min(firstRow, row);
				lastRow = Math.max(lastRow, row);
				firstColumn = Math.min(firstColumn, column);
				lastColumn = Math.max(lastColumn, column);
			}
		}
		if (lastRow < 0) return null;
		const bounds = screen.getBoundingClientRect();
		const cellWidth = bounds.width / terminal.cols;
		const cellHeight = bounds.height / terminal.rows;
		return {
			x: bounds.x + Math.max(0, firstColumn - 4) * cellWidth,
			y: bounds.y + Math.max(0, firstRow - buffer.viewportY - 2) * cellHeight,
			width: (Math.min(terminal.cols, lastColumn + 5) - Math.max(0, firstColumn - 4)) * cellWidth,
			height: (Math.min(terminal.rows, lastRow - buffer.viewportY + 3)
				- Math.max(0, firstRow - buffer.viewportY - 2)) * cellHeight,
			verticalScale: (2 * cellWidth) / cellHeight,
		};
	});
	if (!geometry) throw new Error('terminal QR bounds were not found');
	const screenshot = await page.screenshot({
		animations: 'disabled',
		clip: geometry,
	});
	return {
		request: await decodeQr(await normalizeQrScreenshot(page, screenshot, geometry.verticalScale)),
		endMarker,
	};
}

test('admin scans WebVM join-request QR and WebVM observes signed approval', async ({ page }) => {
	test.setTimeout(300_000);
	const nvpn = nvpnBinary();
	const isolated = createIsolatedAdmin(nvpn);
	const admin = startAdminHelper({ configPath: isolated.configPath, nvpn });
	try {
		await admin.waitForStatus('ready');
		await page.goto('/v86');
		await attachSerial(page);
		await waitUntil(
			() => page.evaluate(() => globalThis.irisWebvmV86?.state?.().fipsStatus?.ethernetPeers > 0),
			{ timeoutMs: 120_000, message: 'WebVM did not attach to browser FIPS' },
		);
		const { request, endMarker } = await startAndScanJoinRequest(page);
		expect(request).toMatch(/^nvpn:\/\/join-request\/[A-Za-z0-9_-]+$/);
		const imported = await admin.approve(request);
		expect(imported.participantAdded).toBe(true);
		await waitUntil(
			() => page.evaluate((marker) => (
				globalThis.__nvpnJoinE2eSerial?.text || ''
			).includes(marker), endMarker),
			{ timeoutMs: 120_000, message: 'WebVM did not observe admin approval' },
		);
		const guestOutput = await page.evaluate(() => globalThis.__nvpnJoinE2eSerial.text);
		expect(guestOutput).toContain('Join approved for network');
		expect(guestOutput).not.toContain('ping: bad address');
		await admin.cleanup();
	} finally {
		admin.stop();
		isolated.cleanup();
	}
});
