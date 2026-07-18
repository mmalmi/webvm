import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { inspectNativeFixture } from '../../scripts/native-fixture.mjs';

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

function runStandardApproval({ fixture, request, dataDir }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.CARGO || 'cargo', [
			'run',
			'--quiet',
			'--locked',
			'--manifest-path',
			fixture.manifest,
			'--example',
			'standard_join_approval_e2e',
			'--',
			'--data-dir',
			dataDir,
			'--join-request',
			request,
			'--nvpn-bin',
			fixture.binary,
			'--timeout-secs',
			'90',
		], {
			cwd: fixture.repository,
			env: {
				...process.env,
				RUSTC_WRAPPER: '',
				RUST_LOG: process.env.NVPN_STANDARD_JOIN_RUST_LOG || 'off',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const events = [];
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
			reject(new Error(`standard approval helper timed out: ${stderr}`));
		}, 120_000);
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
			stderr = `${stderr}${chunk}`.slice(-12_000);
		});
		child.on('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0 || signal) {
				reject(new Error(
					`standard approval helper exited ${signal || code}: ${stderr}`
					+ `\n${events.map((event) => JSON.stringify(event)).join('\n')}`,
				));
				return;
			}
			resolve(events);
		});
	});
}

test('ordinary nVPN pairing crosses the generic Ethernet pubsub uplink', async ({ page }) => {
	test.setTimeout(420_000);
	const fixture = inspectNativeFixture();
	const dataDir = mkdtempSync(path.join(tmpdir(), 'nvpn-standard-join-e2e-'));
	await page.goto('/v86');
	await attachSerial(page);
	try {
		await waitUntil(
			() => page.evaluate(() => globalThis.irisWebvmV86?.state?.().terminalReady === true),
			{ timeoutMs: 120_000, message: 'WebVM shell did not become ready' },
		);
		await runSerialCommand(
			page,
			'ordinary nVPN daemon startup',
			"for i in $(seq 1 120); do rc-service webvm-nvpn status >/dev/null 2>&1 && exit 0; " +
				"sleep 1; done; rc-service webvm-nvpn status; cat /var/log/webvm-nvpn.log; exit 1",
			130_000,
		);
		const output = await runSerialCommand(
			page,
			'normal nVPN join request',
			"! grep -q -- '--webvm-' /usr/local/sbin/webvm-nvpn " +
				"&& grep -qF -- '--fips-ethernet-interface' /usr/local/sbin/webvm-nvpn " +
				"&& grep -qF -- '--fips-ethernet-discovery-scope' /usr/local/sbin/webvm-nvpn " +
				'&& ! nvpn webvm-guest --help >/dev/null 2>&1 ' +
				'&& nvpn join-request --no-qr --no-wait',
		);
		const request = output.find((line) => line.startsWith('nvpn://join-request/'));
		expect(request).toMatch(/^nvpn:\/\/join-request\/[A-Za-z0-9_-]+$/u);
		try {
			await waitUntil(
				() => page.evaluate(() => (
					globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats?.subscriptionBatches || 0
				) > 0),
				{ timeoutMs: 30_000, message: 'ordinary nVPN daemon did not open the FIPS pubsub uplink' },
			);
		} catch (error) {
			const guest = await runSerialCommand(
				page,
				'nVPN uplink diagnostics',
				"rc-service webvm-nvpn status || true; echo __DAEMON_FILES__; " +
					"ls -la /var/lib/nvpn; echo __CONTROL_RESULT__; " +
					"cat /var/lib/nvpn/daemon.control.result.json 2>&1 || true; echo __STATE__; " +
					"cat /var/lib/nvpn/daemon.state.json 2>&1 || true; echo __LOG__; " +
					"cat /var/lib/nvpn/daemon.log 2>&1 || true; " +
					"echo __PID__; cat /var/lib/nvpn/daemon.pid 2>&1 || true; echo __CMDLINE__; " +
					"tr '\\0' ' ' </proc/$(sed -n 's/.*\"pid\": \\([0-9]*\\).*/\\1/p' " +
					"/var/lib/nvpn/daemon.pid)/cmdline 2>&1 || true; echo; " +
					"echo __LINKS__; ip link; " +
					"echo __SCOPE__; cat /run/webvm/fips-discovery-scope 2>&1 || true; " +
					"echo __PROCESSES__; ps; true",
				30_000,
			);
			const browser = await page.evaluate(() => ({
				pubsub: globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats,
				state: globalThis.irisWebvmV86?.state?.(),
			}));
			throw new Error(
				`${error.message}\nJoin:\n${output.join('\n')}\nGuest:\n${guest.join('\n')}` +
					`\nBrowser:\n${JSON.stringify(browser)}`,
			);
		}

		let approvalEvents;
		try {
			approvalEvents = await runStandardApproval({ fixture, request, dataDir });
		} catch (error) {
			const guest = await runSerialCommand(
				page,
				'nVPN approval diagnostics',
				"cat /var/lib/nvpn/daemon.state.json 2>&1 || true; echo __LOG__; " +
					"cat /var/lib/nvpn/daemon.log 2>&1 || true",
				30_000,
			);
			const browser = await page.evaluate(() => ({
				pubsub: globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats,
				state: globalThis.irisWebvmV86?.state?.(),
			}));
			let adminConfig = '';
			try {
				adminConfig = readFileSync(path.join(dataDir, 'config.toml'), 'utf8');
			} catch (readError) {
				adminConfig = `unavailable: ${readError.message}`;
			}
			throw new Error(
				`${error.message}\nAdmin config:\n${adminConfig}\nGuest:\n${guest.join('\n')}` +
					`\nBrowser:\n${JSON.stringify(browser)}`,
			);
		}
		expect(approvalEvents).toEqual(expect.arrayContaining([
			expect.objectContaining({ ok: true, event: 'approved', queueDepth: 1 }),
			expect.objectContaining({ ok: true, event: 'delivered', queueDrained: true }),
		]));
		const approved = await runSerialCommand(
			page,
			'normal signed-roster approval',
			"for i in $(seq 1 120); do result=$(nvpn join-request --no-qr --no-wait); " +
				'printf \'%s\\n\' "$result"; echo "$result" | grep -q \'Already approved for network\' ' +
				"&& exit 0; sleep 0.5; done; exit 1",
			90_000,
		);
		expect(approved.join('\n')).toContain('Already approved for network');

		const stats = await page.evaluate(() => globalThis.irisWebvmV86.fipsHost.pubsub.stats);
		expect(stats.subscriptionBatches).toBeGreaterThan(0);
		expect(stats.relaySubscriptions).toBeGreaterThan(0);
		expect(stats.relayEvents).toBeGreaterThan(0);
		expect(stats.publishBatches).toBeGreaterThan(0);
		expect(stats.serviceErrors).toBe(0);
		expect(Object.keys(stats).some((key) => /approval|stateControl/u.test(key))).toBe(false);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
