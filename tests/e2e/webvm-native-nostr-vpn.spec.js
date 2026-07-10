import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nip19 } from 'nostr-tools';
import { readBarcodes } from 'zxing-wasm/reader';

const REAL_E2E_ENABLED = process.env.NVPN_WEBVM_REAL_E2E === '1';
const HOST_CONFIG_ENV = 'NVPN_WEBVM_HOST_CONFIG';
const NVPN_BIN_ENV = 'NVPN_WEBVM_NVPN_BIN';
const SERIAL_BUFFER_LIMIT = 128 * 1024;
const FIPS_ATTACH_TIMEOUT_MS = Number.parseInt(
	process.env.NVPN_WEBVM_FIPS_ATTACH_TIMEOUT_MS || '120000',
	10,
);
const GUEST_PAIR_TIMEOUT_MS = Number.parseInt(
	process.env.NVPN_WEBVM_GUEST_PAIR_TIMEOUT_MS || '180000',
	10,
);

test.skip(!REAL_E2E_ENABLED, 'set NVPN_WEBVM_REAL_E2E=1 to run the live-host WebVM e2e');
test.use({
	trace: 'off',
	viewport: { width: 1600, height: 1400 },
	deviceScaleFactor: 2,
});

function requireRealFile(envName, { executable = false } = {}) {
	const value = process.env[envName]?.trim();
	if (!value) {
		throw new Error(`${envName} must name an explicit real host file`);
	}
	const resolved = path.resolve(value);
	if (!existsSync(resolved) || !statSync(resolved).isFile()) {
		throw new Error(`${envName} does not name a file`);
	}
	if (executable && process.platform !== 'win32' && (statSync(resolved).mode & 0o111) === 0) {
		throw new Error(`${envName} is not executable`);
	}
	return resolved;
}

function readHostPeerDiagnostics(nvpnBin, configPath, participantPubkey) {
	const result = spawnSync(nvpnBin, ['status', '--config', configPath, '--json'], {
		encoding: 'utf8',
		timeout: 15_000,
	});
	if (result.status !== 0) {
		return { error: `status-exit-${result.status ?? 'unknown'}` };
	}
	try {
		const status = JSON.parse(result.stdout);
		const peer = status?.daemon?.state?.peers?.find(
			(candidate) => candidate.participant_pubkey === participantPubkey,
		);
		return {
			fipsCoreVersion: status?.daemon?.state?.fips_core_version || '',
			effectiveAdvertisedRoutes: status?.effective_advertised_routes || [],
			peer: peer ? {
				reachable: peer.reachable,
				error: peer.error,
				fipsBytesRecv: peer.fips_bytes_recv,
				fipsBytesSent: peer.fips_bytes_sent,
				fipsPacketsRecv: peer.fips_packets_recv,
				fipsPacketsSent: peer.fips_packets_sent,
				fipsCurrentKBit: peer.fips_current_k_bit,
				fipsTransportType: peer.fips_transport_type,
				lastFipsDataSeenAt: peer.last_fips_data_seen_at,
			} : null,
		};
	} catch {
		return { error: 'status-json-invalid' };
	}
}

function expectCompactBootstrap(joinRequest) {
	expect(joinRequest.length).toBeLessThanOrEqual(384);
	const encoded = joinRequest.slice('nvpn://join-request/'.length);
	let payload;
	try {
		payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		throw new Error('guest join request payload is not valid base64url JSON');
	}
	expect(Object.keys(payload).sort()).toEqual([
		'deviceAppKeyNpub',
		'label',
		'requestNpub',
		'requestSecret',
	]);
	expect(payload.requestNpub).toMatch(/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/);
	expect(payload.deviceAppKeyNpub).toMatch(/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/);
	expect(payload.requestNpub).not.toBe(payload.deviceAppKeyNpub);
	expect(payload.requestSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const secret = Buffer.from(payload.requestSecret, 'base64url');
	expect(secret).toHaveLength(32);
	expect(secret.toString('base64url')).toBe(payload.requestSecret);
	expect(Buffer.byteLength(payload.label, 'utf8')).toBeGreaterThan(0);
	expect(Buffer.byteLength(payload.label, 'utf8')).toBeLessThanOrEqual(16);
	return payload;
}

async function decodeQrScreenshot(screenshot) {
	for (const binarizer of ['LocalAverage', 'GlobalHistogram']) {
		const results = await readBarcodes(new Uint8Array(screenshot), {
			formats: ['QRCode'],
			tryHarder: true,
			tryDenoise: true,
			tryDownscale: true,
			downscaleFactor: 2,
			binarizer,
		});
		const decoded = results.find((result) => result.format === 'QRCode' && result.text);
		if (decoded) return decoded.text;
	}
	throw new Error('rendered terminal QR could not be decoded from pixels');
}

async function normalizeRenderedQrScreenshot(page, screenshot, verticalScale) {
	const encoded = screenshot.toString('base64');
	const normalized = await page.evaluate(async ({ encodedPng, scaleY }) => {
		const image = new Image();
		image.src = `data:image/png;base64,${encodedPng}`;
		await new Promise((resolve, reject) => {
			image.onload = resolve;
			image.onerror = () => reject(new Error('failed to decode terminal QR screenshot'));
		});
		const border = 32;
		const canvas = document.createElement('canvas');
		canvas.width = image.width + border * 2;
		canvas.height = Math.round(image.height * scaleY) + border * 2;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.imageSmoothingEnabled = false;
		context.drawImage(
			image,
			border,
			border,
			image.width,
			canvas.height - border * 2,
		);
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
		for (let offset = 0; offset < pixels.data.length; offset += 4) {
			const luminance = (
				pixels.data[offset] * 299 +
				pixels.data[offset + 1] * 587 +
				pixels.data[offset + 2] * 114
			) / 1000;
			const value = luminance >= 128 ? 0 : 255;
			pixels.data[offset] = value;
			pixels.data[offset + 1] = value;
			pixels.data[offset + 2] = value;
			pixels.data[offset + 3] = 255;
		}
		context.putImageData(pixels, 0, 0);
		return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
	}, { encodedPng: encoded, scaleY: verticalScale });
	return Buffer.from(normalized, 'base64');
}

function defaultNativeHelperManifest() {
	return path.resolve(process.cwd(), '../nostr-vpn/crates/nostr-vpn-app-core/Cargo.toml');
}

function waitForChildExit(child, timeoutMs = 30_000) {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.removeListener('exit', onExit);
			reject(new Error('native helper did not exit after cleanup'));
		}, timeoutMs);
		function onExit() {
			clearTimeout(timer);
			resolve();
		}
		child.once('exit', onExit);
	});
}

function startNativeHelper({ configPath, nvpnBin }) {
	const manifest = path.resolve(
		process.env.NVPN_APP_CORE_MANIFEST?.trim() || defaultNativeHelperManifest(),
	);
	if (!existsSync(manifest) || !statSync(manifest).isFile()) {
		throw new Error('Nostr VPN app-core manifest is unavailable');
	}

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
		nvpnBin,
	], {
		cwd: path.dirname(manifest),
		env: {
			...process.env,
			NVPN_WEBVM_REAL_E2E: '1',
			RUST_LOG: 'off',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stderr.resume();

	let stdoutBuffer = '';
	let protocolFailed = false;
	const events = [];
	const waiters = new Set();

	function wakeWaiters() {
		for (const waiter of waiters) waiter.check();
	}

	child.stdout.on('data', (chunk) => {
		stdoutBuffer += chunk.toString();
		for (;;) {
			const newline = stdoutBuffer.indexOf('\n');
			if (newline === -1) break;
			const line = stdoutBuffer.slice(0, newline).trim();
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			try {
				const event = JSON.parse(line);
				if (!event || typeof event.status !== 'string') throw new Error('invalid status');
				events.push(event);
			} catch {
				protocolFailed = true;
			}
			wakeWaiters();
		}
	});

	child.once('exit', (code, signal) => {
		for (const waiter of waiters) {
			waiter.reject(new Error(
				`native helper exited before expected sanitized status: code=${code} signal=${signal}`,
			));
		}
		waiters.clear();
	});

	function waitForStatus(status, timeoutMs = 60_000) {
		const existing = events.find((event) => event.status === status);
		if (existing) return Promise.resolve(existing);
		if (protocolFailed) return Promise.reject(new Error('native helper emitted non-JSON output'));
		return new Promise((resolve, reject) => {
			const waiter = {
				check() {
					if (protocolFailed) {
						waiter.reject(new Error('native helper emitted non-JSON output'));
						return;
					}
					const error = events.find((event) => event.status === 'error');
					if (error) {
						waiter.reject(new Error(
							`native helper failed at ${error.stage || 'unknown'} (${error.code || 'unknown'})`,
						));
						return;
					}
					const event = events.find((candidate) => candidate.status === status);
					if (!event) return;
					clearTimeout(timer);
					waiters.delete(waiter);
					resolve(event);
				},
				reject(error) {
					clearTimeout(timer);
					waiters.delete(waiter);
					reject(error);
				},
			};
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error(`timed out waiting for native helper status ${status}`));
			}, timeoutMs);
			waiters.add(waiter);
			waiter.check();
		});
	}

	function writeLine(line) {
		if (child.exitCode !== null || child.stdin.destroyed) {
			return Promise.reject(new Error('native helper stdin is unavailable'));
		}
		return new Promise((resolve, reject) => {
			child.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve());
		});
	}

	return {
		waitForStatus,
		async importJoinRequest(request) {
			await waitForStatus('ready', 120_000);
			await writeLine(`import ${request}`);
			return waitForStatus('imported', 120_000);
		},
		async cleanup() {
			if (child.exitCode !== null) return;
			try {
				await writeLine('cleanup');
				await waitForStatus('cleaned', 120_000);
				child.stdin.end();
				await waitForChildExit(child);
			} catch (error) {
				child.kill('SIGTERM');
				await waitForChildExit(child, 5_000).catch(() => {});
				throw error;
			}
		},
	};
}

async function waitUntil(check, { timeoutMs, intervalMs = 250, message }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(message);
}

async function attachRealV86Serial(page) {
	await waitUntil(
		() => page.evaluate(() => {
			const emulator = globalThis.irisWebvmV86?.emulator;
			const fipsNode = globalThis.irisWebvmV86?.fipsHost?.node;
			return Boolean(emulator && typeof emulator.serial0_send === 'function' && fipsNode);
		}),
		{ timeoutMs: 120_000, message: 'real v86 emulator did not become serial-ready' },
	);

	const attached = await page.evaluate((bufferLimit) => {
		if (globalThis.irisWebvmV86TestHooks) return false;
		const emulator = globalThis.irisWebvmV86?.emulator;
		if (!emulator || typeof emulator.serial0_send !== 'function') return false;
		const serial = { text: '', decoder: new TextDecoder(), emulator };
		const ethernet = {
			guestFrames: 0,
			guestFipsFrames: 0,
			guestBeacons: 0,
			guestDirectFspRecords: 0,
			guestDirectFspFragments: 0,
			browserFrames: 0,
			browserFipsFrames: 0,
			browserBeacons: 0,
			browserDirectFspRecords: 0,
			browserDirectFspFragments: 0,
			guestFragmentRecords: [],
			browserFragmentRecords: [],
		};
		const readU16le = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
		const readU32le = (bytes, offset) => (
			bytes[offset]
			| (bytes[offset + 1] << 8)
			| (bytes[offset + 2] << 16)
			| (bytes[offset + 3] << 24)
		) >>> 0;
		const readU64leHex = (bytes, offset) => {
			let value = 0n;
			for (let index = 0; index < 8; index += 1) {
				value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
			}
			return value.toString(16);
		};
		const countFrame = (direction, frame) => {
			ethernet[`${direction}Frames`] += 1;
			if (!(frame instanceof Uint8Array) || frame.length < 15) return;
			if (frame[12] !== 0x21 || frame[13] !== 0x21) return;
			ethernet[`${direction}FipsFrames`] += 1;
			if (frame[14] === 0x01) ethernet[`${direction}Beacons`] += 1;
			if (frame[14] !== 0x00 || frame.length < 21) return;
			if (frame[17] === 0x44 && frame[18] === 0x46 && frame[19] === 0x50 && frame[20] === 0x31) {
				ethernet[`${direction}DirectFspFragments`] += 1;
				if (frame.length >= 37) {
					const records = ethernet[`${direction}FragmentRecords`];
					const recordId = readU64leHex(frame, 21);
					const totalLen = readU32le(frame, 29);
					const fragmentIndex = readU16le(frame, 33);
					const fragmentCount = readU16le(frame, 35);
					let record = records.find((candidate) => (
						candidate.recordId === recordId && candidate.totalLen === totalLen
					));
					if (!record && records.length < 32) {
						record = { recordId, totalLen, fragmentCount, indexes: [], frameLengths: [] };
						records.push(record);
					}
					if (record) {
						if (!record.indexes.includes(fragmentIndex)) record.indexes.push(fragmentIndex);
						if (!record.frameLengths.includes(frame.length)) record.frameLengths.push(frame.length);
					}
				}
			} else if (frame[17] === 0x00 && (frame[18] & 0x08) !== 0) {
				ethernet[`${direction}DirectFspRecords`] += 1;
			}
		};
		serial.onByte = (byte) => {
			serial.text += serial.decoder.decode(Uint8Array.of(byte & 0xff), { stream: true });
			if (serial.text.length > bufferLimit) serial.text = serial.text.slice(-bufferLimit);
		};
		serial.onEthernetFrame = (frame) => countFrame('guest', frame);
		serial.fipsErrors = [];
		serial.removeFipsErrorListener = globalThis.irisWebvmV86?.fipsHost?.node?.on(
			'error',
			(event) => {
				const error = event?.err;
				serial.fipsErrors.push({
					where: String(event?.where || 'unknown'),
					message: error instanceof Error ? error.message : String(error || ''),
					stack: error instanceof Error ? error.stack : undefined,
				});
				if (serial.fipsErrors.length > 12) serial.fipsErrors.shift();
			},
		);
		const originalBusSend = emulator.bus.send.bind(emulator.bus);
		emulator.bus.send = (event, data) => {
			if (event === 'net0-receive') countFrame('browser', data);
			return originalBusSend(event, data);
		};
		emulator.add_listener('serial0-output-byte', serial.onByte);
		emulator.add_listener('net0-send', serial.onEthernetFrame);
		serial.ethernet = ethernet;
		globalThis.__nvpnWebvmRealE2eSerial = serial;
		return true;
	}, SERIAL_BUFFER_LIMIT);
	if (!attached) throw new Error('v86 route is using a test hook or lacks a real serial port');
}

async function clearSerial(page) {
	await page.evaluate(() => {
		const serial = globalThis.__nvpnWebvmRealE2eSerial;
		if (serial) {
			serial.text = '';
			serial.decoder = new TextDecoder();
		}
		globalThis.irisWebvmV86?.serialTerminal?.reset();
	});
}

async function captureRenderedPairingQr(page) {
	const marker = `__NVPN_E2E_QR_RENDERED_${randomUUID().replaceAll('-', '')}__`;
	await page.evaluate((readyMarker) => {
		const serial = globalThis.__nvpnWebvmRealE2eSerial;
		if (!serial) throw new Error('serial harness is not attached');
		serial.text = '';
		serial.decoder = new TextDecoder();
		const consoleElement = document.querySelector('[data-testid="v86-serial"]');
		const terminal = globalThis.irisWebvmV86?.serialTerminal;
		if (!consoleElement || !terminal) throw new Error('xterm serial console is unavailable');
		consoleElement.dataset.e2eStyle = consoleElement.getAttribute('style') || '';
		Object.assign(consoleElement.style, {
			height: '1240px',
			width: '1440px',
		});
		terminal.resize(150, 76);
		terminal.reset();
		serial.emulator.serial0_send(`webvm-pair --wait; printf '\\n${readyMarker}\\n'\n`);
	}, marker);

	try {
		await waitUntil(
			() => page.evaluate(
				(readyMarker) => (globalThis.__nvpnWebvmRealE2eSerial?.text || '').includes(readyMarker),
				marker,
			),
			{ timeoutMs: 120_000, message: 'terminal QR did not finish rendering' },
		);
		await page.waitForTimeout(250);
		const qrGeometry = await page.evaluate(() => {
			const terminal = globalThis.irisWebvmV86?.serialTerminal;
			const buffer = terminal?.buffer?.active;
			const screen = document.querySelector('[data-testid="v86-serial"] .xterm-screen');
			if (!terminal || !buffer || !screen) return null;
			let firstRow = Number.POSITIVE_INFINITY;
			let lastRow = -1;
			let firstColumn = Number.POSITIVE_INFINITY;
			let lastColumn = -1;
			const viewportEnd = Math.min(buffer.length, buffer.viewportY + terminal.rows);
			for (let row = buffer.viewportY; row < viewportEnd; row += 1) {
				const line = buffer.getLine(row)?.translateToString(true) || '';
				for (let column = 0; column < line.length; column += 1) {
					if (!/[▀▄█]/u.test(line[column])) continue;
					firstRow = Math.min(firstRow, row);
					lastRow = Math.max(lastRow, row);
					firstColumn = Math.min(firstColumn, column);
					lastColumn = Math.max(lastColumn, column);
				}
			}
			if (lastRow < 0 || lastColumn < 0) return null;
			const bounds = screen.getBoundingClientRect();
			const cellWidth = bounds.width / terminal.cols;
			const cellHeight = bounds.height / terminal.rows;
			const left = Math.max(0, firstColumn - 4);
			const right = Math.min(terminal.cols, lastColumn + 5);
			const top = Math.max(0, firstRow - buffer.viewportY - 2);
			const bottom = Math.min(terminal.rows, lastRow - buffer.viewportY + 3);
			return {
				clip: {
					x: bounds.x + left * cellWidth,
					y: bounds.y + top * cellHeight,
					width: (right - left) * cellWidth,
					height: (bottom - top) * cellHeight,
				},
				verticalScale: (2 * cellWidth) / cellHeight,
			};
		});
		if (!qrGeometry) throw new Error('rendered terminal QR glyph bounds are unavailable');
		const screenshot = await page.screenshot({
			animations: 'disabled',
			clip: qrGeometry.clip,
		});
		try {
			const normalized = await normalizeRenderedQrScreenshot(
				page,
				screenshot,
				qrGeometry.verticalScale,
			);
			return await decodeQrScreenshot(normalized);
		} catch (error) {
			const diagnostics = await page.evaluate((screenshotBytes) => {
				const terminal = globalThis.irisWebvmV86?.serialTerminal;
				const buffer = terminal?.buffer?.active;
				let occupiedRows = 0;
				let maxColumns = 0;
				let blockGlyphs = 0;
				for (let row = 0; row < (buffer?.length || 0); row += 1) {
					const line = buffer.getLine(row)?.translateToString(true) || '';
					if (line.length > 0) occupiedRows += 1;
					maxColumns = Math.max(maxColumns, line.length);
					blockGlyphs += (line.match(/[▀▄█]/gu) || []).length;
				}
				const canvases = [...document.querySelectorAll('[data-testid="v86-serial"] canvas')]
					.map((canvas) => ({ width: canvas.width, height: canvas.height }));
				return {
					screenshotBytes,
					occupiedRows,
					maxColumns,
					blockGlyphs,
					bufferLength: buffer?.length || 0,
					viewportY: buffer?.viewportY ?? null,
					baseY: buffer?.baseY ?? null,
					rows: terminal?.rows || 0,
					cols: terminal?.cols || 0,
					canvases,
				};
			}, screenshot.length);
			throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`);
		}
	} finally {
		await page.evaluate(() => {
			const consoleElement = document.querySelector('[data-testid="v86-serial"]');
			const terminal = globalThis.irisWebvmV86?.serialTerminal;
			terminal?.resize(120, 32);
			if (consoleElement) {
				consoleElement.setAttribute('style', consoleElement.dataset.e2eStyle || '');
				delete consoleElement.dataset.e2eStyle;
			}
		});
		await clearSerial(page);
	}
}

async function waitForGuestApprovalSubscription(page) {
	try {
		await waitUntil(
			() => page.evaluate(() => {
				const stats = globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats;
				return Boolean(stats && (stats.subscriptionBatches > 0 || stats.serviceErrors > 0));
			}),
			{ timeoutMs: 30_000, message: 'guest approval subscription did not reach browser pubsub' },
		);
	} catch (error) {
		const browser = await page.evaluate(() => ({
			fipsStatus: globalThis.irisWebvmV86?.state?.()?.fipsStatus || null,
			pubsub: globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats || null,
			ethernet: globalThis.__nvpnWebvmRealE2eSerial?.ethernet || null,
			fipsErrors: globalThis.__nvpnWebvmRealE2eSerial?.fipsErrors || [],
		}));
		const guest = await runSerialCommand(
			page,
			'join request bridge diagnostics',
			"printf '%s\\n' '--- SERVICE ---'; rc-service webvm-nvpn status 2>&1 || true; printf '%s\\n' '--- LOG ---'; tail -100 /var/log/webvm-nvpn.log 2>/dev/null | sed -E 's#nvpn://[^[:space:]]+#[redacted]#g; s#npub1[a-z0-9]+#npub1[redacted]#g; s#[0-9a-fA-F]{64}#[redacted]#g' || true",
			30_000,
		);
		throw new Error(`${error.message}; browser=${JSON.stringify(browser)}; guest=${guest.join(' | ')}`);
	}
	const stats = await page.evaluate(() => {
		const value = globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats;
		return value ? structuredClone(value) : null;
	});
	if (!stats || stats.subscriptionBatches < 1 || stats.serviceErrors > 0) {
		throw new Error(`browser pubsub rejected guest approval subscription: ${JSON.stringify(stats)}`);
	}
	if (stats.publishBatches !== 0) {
		throw new Error(`guest published a forbidden join request event: ${JSON.stringify(stats)}`);
	}
}

async function runSerialCommand(page, label, command, timeoutMs = 30_000) {
	const token = randomUUID().replaceAll('-', '');
	const begin = `__NVPN_E2E_BEGIN_${token}__`;
	const end = `__NVPN_E2E_END_${token}__`;
	const wrapped = `printf '\\n${begin}\\n'; ( ${command} ); nvpn_e2e_rc=$?; printf '\\n${end}:%s\\n' "$nvpn_e2e_rc"`;
	await page.evaluate((serialCommand) => {
		const serial = globalThis.__nvpnWebvmRealE2eSerial;
		if (!serial) throw new Error('serial harness is not attached');
		serial.text = '';
		serial.emulator.serial0_send(`${serialCommand}\n`);
	}, wrapped);

	let result;
	try {
		await waitUntil(
			async () => {
				result = await page.evaluate(({ beginMarker, endMarker }) => {
					const text = globalThis.__nvpnWebvmRealE2eSerial?.text || '';
					const lines = text.replaceAll('\r', '').split('\n');
					const beginIndex = lines.findIndex((line) => line.trim() === beginMarker);
					if (beginIndex === -1) return null;
					const endIndex = lines.findIndex(
						(line, index) => index > beginIndex && line.trim().startsWith(`${endMarker}:`),
					);
					if (endIndex === -1) return null;
					const statusText = lines[endIndex].trim().slice(endMarker.length + 1);
					if (!/^\d+$/.test(statusText)) return null;
					return {
						status: Number.parseInt(statusText, 10),
						output: lines.slice(beginIndex + 1, endIndex),
					};
				}, { beginMarker: begin, endMarker: end });
				return Boolean(result);
			},
			{ timeoutMs, message: `serial command timed out during ${label}` },
		);
	} finally {
		await clearSerial(page);
	}
	if (result.status !== 0) throw new Error(`serial command failed during ${label}`);
	return result.output.map((line) => line.trim()).filter(Boolean);
}

async function waitForGuestDefaultRoute(page) {
	const deadline = Date.now() + GUEST_PAIR_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const output = await runSerialCommand(
			page,
			'guest auto-pair route check',
			"if ip route show default | grep -Eq '(^|[[:space:]])dev[[:space:]]+nvpn0([[:space:]]|$)'; then printf 'NVPN0_DEFAULT\\n'; else printf 'PAIRING_PENDING\\n'; fi",
		);
		if (output.includes('NVPN0_DEFAULT')) return;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	const browser = await page.evaluate(() => {
		const service = globalThis.irisWebvmV86?.fipsHost?.pubsub?.service;
		const stats = globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats;
		return {
			fipsStatus: globalThis.irisWebvmV86?.state?.().fipsStatus?.state || 'unknown',
			pubsubPeers: service?.activePeerCount?.() ?? -1,
			pubsubSubscriptions: service?.activeSubscriptionCount?.() ?? -1,
			pubsubStats: stats ? { ...stats } : null,
			ethernet: { ...(globalThis.__nvpnWebvmRealE2eSerial?.ethernet || {}) },
		};
	});
	let guest;
	try {
		guest = await runSerialCommand(
			page,
			'guest auto-pair diagnostics',
			"printf '%s\\n' '--- INTERFACES ---'; ip -brief link show 2>&1 || true; ip -s link show eth0 2>&1 || true; printf '%s\\n' '--- ROUTES ---'; ip route show table all 2>&1 || true; printf '%s\\n' '--- STATE FILES ---'; for f in /run/webvm/pairing-uri /var/lib/nvpn/config.toml; do if [ -s \"$f\" ]; then printf '%s:present\\n' \"$f\"; else printf '%s:missing\\n' \"$f\"; fi; done; printf '%s\\n' '--- REDACTED NVPN LOG ---'; tail -120 /var/log/webvm-nvpn.log 2>/dev/null | sed -E 's#nvpn://[^[:space:]]+#[redacted]#g; s#npub1[a-z0-9]+#npub1[redacted]#g; s#[0-9a-fA-F]{64}#[redacted]#g' || true",
			30_000,
		);
	} catch (error) {
		guest = [`diagnostics unavailable: ${error.message}`];
	}
	throw new Error(
		`guest did not auto-pair with nvpn0 as its default route: ${JSON.stringify({ browser, guest })}`,
	);
}

async function describeFipsAttachFailure(page) {
	const browserState = await page.evaluate(() => {
		const state = globalThis.irisWebvmV86?.state?.() || null;
		if (!state) return null;
		const { publicKeyHex: _publicKeyHex, nodeAddrHex: _nodeAddrHex, ...fipsStatus } = state.fipsStatus || {};
		return {
			...state,
			fipsStatus,
			ethernet: globalThis.__nvpnWebvmRealE2eSerial?.ethernet || null,
		};
	});
	let guestState;
	try {
		guestState = await runSerialCommand(
			page,
			'FIPS attach diagnostics',
			"printf '%s\\n' '--- OPENRC ---'; rc-service webvm-underlay status 2>&1 || true; rc-service webvm-nvpn status 2>&1 || true; rc-service webvm-hashtree status 2>&1 || true; printf '%s\\n' '--- PROCESS ---'; pgrep -af 'nvpn webvm-guest' 2>&1 || true; printf '%s\\n' '--- PACKET SOCKETS ---'; cat /proc/net/packet 2>&1 || true; printf '%s\\n' '--- LINK ---'; ip -s link show eth0 2>&1 || true; ip -o address show dev eth0 2>&1 || true; printf '%s\\n' '--- ROUTES ---'; ip route show table all 2>&1 || true; ip -6 route show table all 2>&1 || true; printf '%s\\n' '--- REDACTED ERRORS ---'; grep -Ei 'error|failed|ethernet|awaiting|active' /var/log/webvm-nvpn.log 2>/dev/null | tail -40 | sed -E 's#nvpn://[^[:space:]]+#[redacted]#g; s#npub1[a-z0-9]+#npub1[redacted]#g; s#[0-9a-fA-F]{64}#[redacted]#g' || true",
			30_000,
		);
	} catch (error) {
		guestState = [`diagnostics unavailable: ${error.message}`];
	}
	return JSON.stringify({ browserState, guestState });
}

async function assertStableGuestFmpLinks(page) {
	await waitUntil(
		() => page.evaluate(() => (
			(globalThis.irisWebvmV86?.state?.().fipsStatus?.ethernetPeers || 0) >= 2
		)),
		{ timeoutMs: FIPS_ATTACH_TIMEOUT_MS, message: 'both guest FIPS Ethernet peers did not attach' },
	);
	await page.waitForTimeout(25_000);
	const msg1ByMac = await page.evaluate(() => ({
		...(globalThis.irisWebvmV86?.fipsHost?.ethernetFrameStats?.guestFmpMsg1ByMac || {}),
	}));
	const counts = Object.values(msg1ByMac);
	expect(Object.keys(msg1ByMac)).toHaveLength(2);
	expect(counts).toEqual([1, 1]);
}

test('real WebVM guest auto-pairs through NativeAppAction and reaches HTTPS over nvpn0', async ({ page }) => {
	test.setTimeout(420_000);
	const configPath = requireRealFile(HOST_CONFIG_ENV);
	const nvpnBin = requireRealFile(NVPN_BIN_ENV, { executable: true });
	let native;
	let joinRequest = '';
	let guestParticipantPubkey = '';
	let testFailure = null;

	try {
		native = startNativeHelper({ configPath, nvpnBin });
		await native.waitForStatus('ready', 120_000);
		await page.goto('/v86');
		await attachRealV86Serial(page);
		try {
			await waitUntil(
				() => page.evaluate(() => {
					const status = globalThis.irisWebvmV86?.state?.().fipsStatus;
					return status?.state === 'ready' && status.ethernetPeers > 0;
				}),
				{
					timeoutMs: FIPS_ATTACH_TIMEOUT_MS,
					message: 'real v86 guest did not attach to the browser FIPS Ethernet host',
				},
			);
		} catch (error) {
			const diagnostics = await describeFipsAttachFailure(page);
			throw new Error(`${error.message}: ${diagnostics}`);
		}
		await assertStableGuestFmpLinks(page);

		const shellReady = await runSerialCommand(page, 'guest shell readiness', "printf 'SHELL_READY\\n'");
		expect(shellReady).toContain('SHELL_READY');

		const hashtreeSmoke = await runSerialCommand(
			page,
			'pre-pair local Hashtree smoke',
			"for attempt in $(seq 1 60); do if ss -ltn | grep -Eq '127\\.0\\.0\\.1:80[[:space:]]'; then break; fi; sleep 1; done; smoke_dir=/run/webvm/e2e-htree; rm -rf \"$smoke_dir\"; mkdir -p \"$smoke_dir\"; printf 'webvm-hashtree-e2e' >\"$smoke_dir/index.html\"; if [ \"${HTREE_LOCAL_DAEMON_ONLY:-}\" = 1 ] && command -v git-remote-htree >/dev/null && ss -ltn | grep -Eq '127\\.0\\.0\\.1:80[[:space:]]'; then add_output=$(htree add \"$smoke_dir\" --unencrypted --local 2>/dev/null) || add_output=; nhash=$(printf '%s\\n' \"$add_output\" | awk '/^  url:/ { print $2; exit }'); case \"$nhash\" in nhash1*) if [ \"$(curl --noproxy '*' -H 'Accept: text/html' -fsS --connect-timeout 5 --max-time 15 \"http://${nhash}.iris.localhost/\" 2>/dev/null)\" = 'webvm-hashtree-e2e' ]; then smoke=ok; else smoke=failed; fi ;; *) smoke=failed ;; esac; else smoke=failed; fi; rm -rf \"$smoke_dir\"; if [ \"$smoke\" = ok ]; then printf 'HASHTREE_LOCAL_OK\\n'; else printf 'HASHTREE_LOCAL_FAILED\\n'; fi",
			90_000,
		);
			expect(hashtreeSmoke).toContain('HASHTREE_LOCAL_OK');

			const browserFipsNpub = await page.evaluate(() => {
				const publicKeyHex = globalThis.irisWebvmV86?.state?.().fipsStatus?.publicKeyHex;
				if (!/^(02|03)[0-9a-f]{64}$/i.test(publicKeyHex || '')) {
					throw new Error('browser FIPS identity is unavailable');
				}
				return publicKeyHex.slice(2);
			}).then((xOnlyHex) => nip19.npubEncode(xOnlyHex));
			const prePairDns = await runSerialCommand(
				page,
				'pre-pair private DNS and public refusal',
				`iris=$(dig +time=2 +tries=1 +short A nhash1webvme2e.iris.localhost @127.0.0.1 2>/dev/null | head -1); fips=$(dig +time=5 +tries=1 +short AAAA ${browserFipsNpub}.fips @127.0.0.1 2>/dev/null | head -1); public_status=$(dig +time=2 +tries=1 A api.ipify.org @127.0.0.1 2>/dev/null | sed -n 's/.*status: \\([A-Z]*\\),.*/\\1/p' | head -1); printf 'PREPAIR_DNS:iris=%s:fips=%s:public=%s\\n' \"$iris\" \"$fips\" \"$public_status\"`,
				30_000,
			);
			const prePairDnsLine = prePairDns.find((line) => line.startsWith('PREPAIR_DNS:')) || '';
			expect(prePairDnsLine).toContain('iris=127.0.0.1');
			expect(prePairDnsLine).toMatch(/:fips=fd[0-9a-f:]+:/i);
			expect(prePairDnsLine).toContain('public=REFUSED');

			const prePair = await runSerialCommand(
			page,
			'pre-pair internet isolation',
			"if ip -o address show dev eth0 scope global | grep -q .; then eth_l3=present; else eth_l3=absent; fi; if ip route show table all | grep -Eq '^[[:space:]]*default([[:space:]]|$)'; then v4_default=present; else v4_default=absent; fi; if ip -6 route show table all | grep -Eq '^[[:space:]]*default([[:space:]]|$)'; then v6_default=present; else v6_default=absent; fi; if ip route get 1.1.1 >/dev/null 2>&1; then raw_ip=reachable; else raw_ip=blocked; fi; if dig +time=2 +tries=1 A api4.ipify.org @1.1.1 >/dev/null 2>&1; then direct_dns=reachable; else direct_dns=blocked; fi; printf 'PREPAIR:%s:%s:%s:%s:%s\\n' \"$eth_l3\" \"$v4_default\" \"$v6_default\" \"$raw_ip\" \"$direct_dns\"",
			30_000,
		);
		expect(prePair).toContain('PREPAIR:absent:absent:absent:blocked:blocked');

		if (process.env.NVPN_WEBVM_GUEST_DEBUG === '1') {
			const debugRestart = await runSerialCommand(
				page,
				'guest debug restart',
				"mkdir -p /etc/conf.d; printf '%s\\n' 'export RUST_LOG=fips_core::node::handlers::rx_loop::dataplane=debug,fips_core::node::handlers::session=debug' 'export NVPN_FIPS_PACKET_DEBUG=1' > /etc/conf.d/webvm-nvpn; : > /var/log/webvm-nvpn.log; rc-service webvm-nvpn restart >/dev/null; for attempt in $(seq 1 60); do [ -s /run/webvm/pairing-uri ] && break; sleep 1; done; if [ -s /run/webvm/pairing-uri ]; then printf 'GUEST_DEBUG_READY\\n'; else printf 'GUEST_DEBUG_FAILED\\n'; fi",
				90_000,
			);
			expect(debugRestart).toContain('GUEST_DEBUG_READY');
		}

		joinRequest = await captureRenderedPairingQr(page);
		if (!joinRequest.startsWith('nvpn://join-request/') || joinRequest.includes(' ')) {
			throw new Error('decoded terminal QR is not one canonical join bootstrap');
		}
		const bootstrap = expectCompactBootstrap(joinRequest);
		guestParticipantPubkey = nip19.decode(bootstrap.deviceAppKeyNpub).data;
		await waitForGuestApprovalSubscription(page);

		const imported = await native.importJoinRequest(joinRequest);
		joinRequest = '';
		expect(imported.participantAdded).toBe(true);
		expect(imported.exitNode).toMatch(/^[0-9a-f]{64}$/i);

		await waitForGuestDefaultRoute(page);
		const selectedExit = await runSerialCommand(
			page,
			'approved exit selection',
			"exit_node=$(sed -n 's/^exit_node = \"\\([^\"]*\\)\".*/\\1/p' /var/lib/nvpn/config.toml | head -1); printf 'GUEST_EXIT:%s\\n' \"$exit_node\"",
		);
		expect(selectedExit).toContain(`GUEST_EXIT:${nip19.npubEncode(imported.exitNode)}`);
		const httpsResult = await runSerialCommand(
			page,
			'external HTTPS request',
			"result_file=/run/webvm/e2e-ipify; rm -f \"$result_file\"; dns_ip=; for attempt in $(seq 1 10); do dns_ip=$(dig +time=5 +tries=1 +short A api4.ipify.org @127.0.0.1 2>/dev/null | awk '/^([0-9]{1,3}\\.){3}[0-9]{1,3}$/ { print; exit }'); [ -n \"$dns_ip\" ] && break; sleep 1; done; if [ -n \"$dns_ip\" ]; then dns=ok; else dns=failed; fi; if ip route get 1.1.1 2>/dev/null | grep -Eq '(^|[[:space:]])dev[[:space:]]+nvpn0([[:space:]]|$)'; then route=ok; else route=failed; fi; if [ \"$dns\" = ok ] && [ \"$route\" = ok ] && curl --proto '=https' --tlsv1.2 --resolve \"api4.ipify.org:443:$dns_ip\" -fsS --connect-timeout 15 --max-time 45 -o \"$result_file\" https://api4.ipify.org 2>/dev/null && grep -Eq '^([0-9]{1,3}\\.){3}[0-9]{1,3}$' \"$result_file\"; then printf 'HTTPS_OK:%s\\n' \"$(cat \"$result_file\")\"; else printf 'HTTPS_FAILED dns=%s route=%s\\n' \"$dns\" \"$route\"; printf '%s\\n' '--- ROUTE ---'; ip route get 1.1.1 2>&1 || true; printf '%s\\n' '--- NVPN0 ---'; ip -s link show nvpn0 2>&1 || true; printf '%s\\n' '--- FIPS TUN ---'; ip -s link show nvpnfips0 2>&1 || true; printf '%s\\n' '--- NET DEV ---'; cat /proc/net/dev 2>&1 || true; printf '%s\\n' '--- NVPN STATUS ---'; nvpn status --config /var/lib/nvpn/config.toml --json 2>&1 | sed -E 's#nvpn://[^[:space:]\"]+#[redacted]#g; s#npub1[a-z0-9]+#npub1[redacted]#g' || true; printf '%s\\n' '--- RESOLVER ---'; sed -n '1,20p' /etc/resolv.conf 2>&1 || true; printf '%s\\n' '--- REDACTED NVPN LOG ---'; sed -E 's#nvpn://[^[:space:]]+#[redacted]#g; s#npub1[a-z0-9]+#npub1[redacted]#g; s#[0-9a-fA-F]{64}#[redacted]#g' /var/log/webvm-nvpn.log 2>/dev/null | grep -E 'fips: (TUN packet|mesh -> TUN|failed)|dataplane (raw ingress dropped|packet dropped)|Session established|Dispatching dataplane authenticated session|approval applied' | tail -300 || true; fi; rm -f \"$result_file\"",
			120_000,
			);
			const httpsOk = httpsResult.find((line) => line.startsWith('HTTPS_OK:'));
			if (!httpsOk) {
				const host = readHostPeerDiagnostics(nvpnBin, configPath, guestParticipantPubkey);
				const browser = await page.evaluate(() => {
					const state = globalThis.irisWebvmV86?.state?.() || null;
					const status = state?.fipsStatus || null;
					return status ? {
						state: status.state,
						lastPeerError: status.lastPeerError,
						lastPeerErrorWhere: status.lastPeerErrorWhere,
						ethernetPeers: status.ethernetPeers,
						webrtcPeers: status.webrtcPeers,
						fipsErrors: globalThis.__nvpnWebvmRealE2eSerial?.fipsErrors || [],
						guestFmpMsg1ByMac: {
							...(globalThis.irisWebvmV86?.fipsHost?.ethernetFrameStats?.guestFmpMsg1ByMac || {}),
						},
						ethernet: globalThis.__nvpnWebvmRealE2eSerial?.ethernet || null,
					} : null;
				});
				throw new Error(
					`guest public HTTPS exit failed: ${JSON.stringify({ httpsResult, browser, host })}`,
				);
			}
			expect(httpsOk).toMatch(/^HTTPS_OK:([0-9]{1,3}\.){3}[0-9]{1,3}$/);
	} catch (error) {
		testFailure = error;
		throw error;
	} finally {
		joinRequest = '';
		await clearSerial(page).catch(() => {});
		try {
			await native?.cleanup();
		} catch (cleanupError) {
			if (!testFailure) throw cleanupError;
		}
	}
});
