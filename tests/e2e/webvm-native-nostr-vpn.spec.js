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
	const installedAppBinary = '/Applications/Nostr VPN.app/Contents/Resources/nvpn';
	const sourceBinary = path.join(process.cwd(), '../nostr-vpn/target/debug/nvpn');
	const binary = path.resolve(
		process.env.NVPN_WEBVM_NVPN_BIN?.trim()
			|| (existsSync(sourceBinary) ? sourceBinary : '')
			|| installedAppBinary,
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

function startAdminHelper({ configPath }) {
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
	await page.evaluate(() => {
		const terminal = globalThis.irisWebvmV86.serialTerminal;
		const consoleElement = document.querySelector('[data-testid="v86-serial"]');
		Object.assign(consoleElement.style, { width: '1440px', height: '1240px' });
		terminal.resize(150, 76);
		terminal.reset();
		globalThis.__nvpnJoinE2eSerial.text = '';
		globalThis.__nvpnJoinE2eSerial.emulator.serial0_send('nvpn join-request\n');
	});
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
	};
}

test('admin approval reaches WebVM directly over FIPS without relay traffic', async ({ page }) => {
	test.setTimeout(300_000);
	// The production Worker sends this response directive for rootfs chunks.
	// Mirror it in Vite preview so Chromium never needs a disk-cache write to boot.
	await page.route('**/v86/guest/rootfs/*.bin.zst', async (route) => {
		const response = await route.fetch();
		await route.fulfill({
			response,
			headers: { ...response.headers(), 'cache-control': 'no-store' },
		});
	});
	const browserMessages = [];
	page.on('console', (message) => {
		browserMessages.push(`${message.type()}: ${message.text()}`);
		if (browserMessages.length > 200) browserMessages.shift();
	});
	const nvpn = nvpnBinary();
	const isolated = createIsolatedAdmin(nvpn);
	const admin = startAdminHelper({ configPath: isolated.configPath });
	try {
		await admin.waitForStatus('ready');
		await page.goto('/v86');
		await attachSerial(page);
		await waitUntil(
			() => page.evaluate(() => globalThis.irisWebvmV86?.state?.().fipsStatus?.ethernetPeers > 0),
			{ timeoutMs: 120_000, message: 'WebVM did not attach to browser FIPS' },
		);
		const { request } = await startAndScanJoinRequest(page);
		expect(request).toMatch(
			/^nvpn:\/\/join-request\/[A-Za-z0-9_-]+\?r=[A-Za-z0-9_-]{43}$/,
		);
		const approvalStartedAt = Date.now();
		const deliveryTimeline = [];
		let lastDeliveryState = '';
		const captureDeliveryState = async () => {
			const state = await page.evaluate(() => {
				const stats = globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats || {};
				return {
					approvalSeen: (globalThis.__nvpnJoinE2eSerial?.text || '')
						.includes('Join approved for network'),
					activeSubscriptions:
						globalThis.irisWebvmV86?.fipsHost?.pubsub?.service?.activeSubscriptionCount?.(),
					pendingReplies:
						globalThis.irisWebvmV86?.fipsHost?.pubsub?.service?.pendingReplies?.size,
					directApprovalForwards: stats.directApprovalForwards,
					directRouteRegistrations: stats.directRouteRegistrations,
					subscriptionBatches: stats.subscriptionBatches,
					relayEvents: stats.relayEvents,
					relaySubscriptions: stats.relaySubscriptions,
					relaySubscriptionFailures: stats.relaySubscriptionFailures,
					serviceErrors: stats.serviceErrors,
				};
			});
			const comparable = JSON.stringify(state);
			if (comparable !== lastDeliveryState) {
				lastDeliveryState = comparable;
				const sample = { elapsedMs: Date.now() - approvalStartedAt, ...state };
				deliveryTimeline.push(sample);
				console.log(`native approval delivery state ${JSON.stringify(sample)}`);
			}
			return state;
		};
		const beforeApproval = await captureDeliveryState();
		expect(beforeApproval.approvalSeen).toBe(false);
		expect(beforeApproval.directRouteRegistrations ?? 0).toBeGreaterThanOrEqual(1);
		expect(beforeApproval.directApprovalForwards ?? 0).toBe(0);
		expect(beforeApproval.subscriptionBatches ?? 0).toBe(0);
		expect(beforeApproval.relayEvents ?? 0).toBe(0);
		expect(beforeApproval.relaySubscriptions ?? 0).toBe(0);
		const imported = await admin.approve(request);
		expect(imported.participantAdded).toBe(true);
		expect(imported.directEvents).toBe(2);
		try {
			await waitUntil(
				async () => (await captureDeliveryState()).approvalSeen,
				{ timeoutMs: 5_000, message: 'WebVM did not observe admin approval within 5 seconds' },
			);
		} catch (error) {
			const diagnostics = await page.evaluate(() => ({
				fips: globalThis.irisWebvmV86?.state?.().fipsStatus,
				pubsub: globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats,
			}));
			await page.evaluate(() => {
				globalThis.__nvpnJoinE2eSerial.emulator.serial0_send('\u0003');
			});
			await waitUntil(
				() => page.evaluate(() => {
					const text = globalThis.__nvpnJoinE2eSerial?.text || '';
					const stopped = text.lastIndexOf('Stopped waiting');
					return stopped >= 0 && text.indexOf('root@webvm:~#', stopped) > stopped;
				}),
				{ timeoutMs: 10_000, message: 'WebVM join command did not stop' },
			);
			await page.evaluate(() => {
				globalThis.__nvpnJoinE2eSerial.text = '';
				globalThis.__nvpnJoinE2eSerial.emulator.serial0_send(
					'rc-service webvm-nvpn stop >/dev/null; tail -n 120 /var/log/webvm-nvpn.log; printf "\\n__NVPN_GUEST_LOG__\\n"\n',
				);
			});
			await waitUntil(
				() => page.evaluate(() => (
					(globalThis.__nvpnJoinE2eSerial?.text || '')
						.match(/__NVPN_GUEST_LOG__/g)?.length || 0
				) >= 2),
				{ timeoutMs: 10_000, message: 'WebVM guest log did not render' },
			);
			const guestLog = await page.evaluate(() => globalThis.__nvpnJoinE2eSerial.text.slice(-16_000));
			throw new Error(
				`${error.message}: ${JSON.stringify(diagnostics)}\nBrowser log:\n${browserMessages.join('\n')}\nGuest log:\n${guestLog}`,
			);
		}
		const guestOutput = await page.evaluate(() => globalThis.__nvpnJoinE2eSerial.text);
		expect(guestOutput).toContain('Join approved for network');
		expect(guestOutput).not.toContain('ping: bad address');
		const approvalLatencyMs = Date.now() - approvalStartedAt;
		const afterApproval = await captureDeliveryState();
		console.log(`native approval reached WebVM in ${approvalLatencyMs}ms`);
		console.log(`native approval delivery timeline ${JSON.stringify(deliveryTimeline)}`);
		expect(approvalLatencyMs).toBeLessThanOrEqual(5_000);
		expect(afterApproval.directApprovalForwards).toBe(imported.directEvents);
		expect(afterApproval.subscriptionBatches ?? 0).toBe(0);
		expect(afterApproval.relayEvents ?? 0).toBe(0);
		expect(afterApproval.relaySubscriptions ?? 0).toBe(0);
		await admin.cleanup();
	} finally {
		admin.stop();
		isolated.cleanup();
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	}
});
