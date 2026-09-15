import { createECDH } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('a saved roster and selected exit start without waiting for Internet DNS', async ({ page }) => {
	test.setTimeout(90_000);
	const peers = Array.from({ length: 10 }, () => {
		const key = createECDH('secp256k1');
		key.generateKeys();
		return key.getPublicKey(null, 'compressed').subarray(1).toString('hex');
	});
	await page.goto('/v86?snapshot-build');
	await page.waitForFunction(() => globalThis.irisWebvmV86?.state().terminalReady);
	await page.evaluate((devices) => {
		globalThis.irisWebvmV86.emulator.serial0_send(
			`stty -echo; nvpn init --config /var/lib/nvpn/config.toml ` +
			devices.map((peer) => `--device ${peer}`).join(' ') +
			` >/dev/null && nvpn set --exit-node ${devices[0]} >/dev/null && ` +
			`printf '__IRIS_ROSTER_%s__\\n' READY; stty echo\n`,
		);
	}, peers);
	await page.waitForFunction(() => {
		const buffer = globalThis.irisWebvmV86.serialTerminal.buffer.active;
		for (let row = 0; row < buffer.length; row += 1) {
			if (buffer.getLine(row)?.translateToString(true).trim() === '__IRIS_ROSTER_READY__') {
				return true;
			}
		}
		return false;
	});
	await page.evaluate(() => globalThis.irisWebvmV86.flushDisk());

	await page.goto('/v86');
	await page.waitForFunction(() => globalThis.irisWebvmV86?.state().terminalReady, null, {
		timeout: 60_000,
	});
	const result = await page.evaluate(async () => {
		const bytes = await globalThis.irisWebvmV86.emulator.read_file('/var/lib/nvpn/daemon.state.json');
		const state = JSON.parse(new TextDecoder().decode(bytes));
		return {
			expectedPeers: state.expected_peer_count,
			startupMs: performance.getEntriesByName('webvm-nvpn-startup')[0]?.duration,
		};
	});
	expect(result.expectedPeers).toBe(10);
	expect(result.startupMs).toBeGreaterThan(0);
	console.log(`Saved roster nVPN startup: ${Math.round(result.startupMs)}ms`);
	const budget = Number(process.env.WEBVM_MAX_NVPN_STARTUP_MS || '20000');
	expect(result.startupMs).toBeLessThanOrEqual(budget);
});
