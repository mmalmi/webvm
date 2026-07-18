import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

const REAL_E2E_ENABLED = process.env.NVPN_WEBVM_REAL_E2E === '1';
const SERIAL_BUFFER_LIMIT = 128 * 1024;

test.skip(!REAL_E2E_ENABLED, 'set NVPN_WEBVM_REAL_E2E=1 to run the real nVPN guest e2e');
test.use({ trace: 'off' });

async function waitUntil(check, { timeoutMs, intervalMs = 100, message }) {
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
		globalThis.__nvpnStandardE2eSerial = serial;
	}, SERIAL_BUFFER_LIMIT);
}

async function runSerialCommand(page, label, command, timeoutMs = 60_000) {
	const token = randomUUID().replaceAll('-', '');
	const begin = `__NVPN_STANDARD_BEGIN_${token}__`;
	const end = `__NVPN_STANDARD_END_${token}__`;
	const wrapped = `printf '\\n${begin}\\n'; ( ${command} ); rc=$?; printf '\\n${end}:%s\\n' "$rc"`;
	await page.evaluate((serialCommand) => {
		const serial = globalThis.__nvpnStandardE2eSerial;
		if (!serial) throw new Error('serial harness is not attached');
		serial.text = '';
		serial.decoder = new TextDecoder();
		serial.emulator.serial0_send(`${serialCommand}\n`);
	}, wrapped);

	let result;
	await waitUntil(
		async () => {
			result = await page.evaluate(({ beginMarker, endMarker }) => {
				const lines = (globalThis.__nvpnStandardE2eSerial?.text || '')
					.replaceAll('\r', '').split('\n');
				const beginIndex = lines.findIndex((line) => line.trim() === beginMarker);
				if (beginIndex < 0) return null;
				const endIndex = lines.findIndex((line, index) => (
					index > beginIndex && line.trim().startsWith(`${endMarker}:`)
				));
				if (endIndex < 0) return null;
				const status = Number.parseInt(lines[endIndex].trim().slice(endMarker.length + 1), 10);
				if (!Number.isInteger(status)) return null;
				return { status, output: lines.slice(beginIndex + 1, endIndex) };
			}, { beginMarker: begin, endMarker: end });
			return Boolean(result);
		},
		{ timeoutMs, message: `serial command timed out during ${label}` },
	);
	if (result.status !== 0) {
		throw new Error(`serial command failed during ${label}: ${result.output.join(' | ')}`);
	}
	return result.output.map((line) => line.trim()).filter(Boolean);
}

test('WebVM uses the ordinary nVPN binary and join-request flow', async ({ page }) => {
	test.setTimeout(240_000);
	await page.goto('/v86');
	await attachSerial(page);
	await waitUntil(
		() => page.evaluate(() => globalThis.irisWebvmV86?.state?.().terminalReady === true),
		{ timeoutMs: 120_000, message: 'WebVM shell did not become ready' },
	);

	const output = await runSerialCommand(
		page,
		'normal nVPN join request',
		"! grep -q -- '--webvm-' /usr/local/sbin/webvm-nvpn " +
			'&& ! nvpn webvm-guest --help >/dev/null 2>&1 ' +
			'&& nvpn join-request --no-qr --no-wait',
	);
	const request = output.find((line) => line.startsWith('nvpn://join-request/'));
	expect(request).toMatch(/^nvpn:\/\/join-request\/[A-Za-z0-9_-]+$/u);

	const stats = await page.evaluate(() => globalThis.irisWebvmV86.fipsHost.pubsub.stats);
	expect(Object.keys(stats).some((key) => /approval|stateControl/u.test(key))).toBe(false);
});
