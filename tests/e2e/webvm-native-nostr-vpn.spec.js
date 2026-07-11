import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REAL_E2E_ENABLED = process.env.NVPN_WEBVM_REAL_E2E === '1';
const SERIAL_BUFFER_LIMIT = 128 * 1024;

test.skip(!REAL_E2E_ENABLED, 'set NVPN_WEBVM_REAL_E2E=1 to run the real WebVM guest e2e');
test.use({ trace: 'off', viewport: { width: 1600, height: 1200 } });

function nvpnBinary() {
	const resolved = path.resolve(
		process.env.NVPN_WEBVM_NVPN_BIN?.trim()
			|| path.join(process.cwd(), '../nostr-vpn/target/debug/nvpn'),
	);
	if (!existsSync(resolved) || !statSync(resolved).isFile()) {
		throw new Error(`nVPN binary is unavailable: ${resolved}`);
	}
	if (process.platform !== 'win32' && (statSync(resolved).mode & 0o111) === 0) {
		throw new Error(`nVPN binary is not executable: ${resolved}`);
	}
	return resolved;
}

function createNetworkInvite(binary) {
	const directory = mkdtempSync(path.join(tmpdir(), 'iris-webvm-invite-'));
	const config = path.join(directory, 'config.toml');
	try {
		const initialized = execFileSync(binary, ['init', '--force', '--config', config], {
			encoding: 'utf8',
		});
		const admin = initialized.match(/^nostr_pubkey=(npub1\S+)$/m)?.[1];
		if (!admin) throw new Error('nVPN init did not report the admin identity');
		execFileSync(binary, [
			'init', '--force', '--device', admin, '--config', config,
		], { stdio: 'ignore' });
		const invite = execFileSync(binary, ['create-invite', '--config', config], {
			encoding: 'utf8',
		}).trim();
		if (!invite.startsWith('nvpn://invite/')) {
			throw new Error('nVPN did not create a normal network invite');
		}
		return invite;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

async function waitUntil(check, { timeoutMs, intervalMs = 250, message }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(message);
}

async function attachSerial(page) {
	await waitUntil(
		() => page.evaluate(() => {
			const emulator = globalThis.irisWebvmV86?.emulator;
			return Boolean(emulator && typeof emulator.serial0_send === 'function');
		}),
		{ timeoutMs: 120_000, message: 'real v86 emulator did not become serial-ready' },
	);
	const attached = await page.evaluate((bufferLimit) => {
		const emulator = globalThis.irisWebvmV86?.emulator;
		if (!emulator || globalThis.__nvpnWebvmRealE2eSerial) return false;
		const serial = { text: '', decoder: new TextDecoder(), emulator };
		serial.onByte = (byte) => {
			serial.text += serial.decoder.decode(Uint8Array.of(byte & 0xff), { stream: true });
			if (serial.text.length > bufferLimit) serial.text = serial.text.slice(-bufferLimit);
		};
		emulator.add_listener('serial0-output-byte', serial.onByte);
		globalThis.__nvpnWebvmRealE2eSerial = serial;
		return true;
	}, SERIAL_BUFFER_LIMIT);
	if (!attached) throw new Error('real v86 serial port is unavailable or already attached');
}

async function runSerialCommand(page, label, command, timeoutMs = 30_000) {
	const token = randomUUID().replaceAll('-', '');
	const begin = `__NVPN_E2E_BEGIN_${token}__`;
	const end = `__NVPN_E2E_END_${token}__`;
	const wrapped = `printf '\\n${begin}\\n'; ( ${command} ); rc=$?; printf '\\n${end}:%s\\n' "$rc"`;
	await page.evaluate((serialCommand) => {
		const serial = globalThis.__nvpnWebvmRealE2eSerial;
		if (!serial) throw new Error('serial harness is not attached');
		serial.text = '';
		serial.decoder = new TextDecoder();
		serial.emulator.serial0_send(`${serialCommand}\n`);
	}, wrapped);

	let result;
	await waitUntil(
		async () => {
			result = await page.evaluate(({ beginMarker, endMarker }) => {
				const lines = (globalThis.__nvpnWebvmRealE2eSerial?.text || '')
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

test('real WebVM imports a normal invite and queues pairing over FIPS', async ({ page }) => {
	test.setTimeout(240_000);
	const invite = createNetworkInvite(nvpnBinary());

	await page.goto('/v86?cold-boot');
	await attachSerial(page);
	await waitUntil(
		() => page.evaluate(() => {
			const status = globalThis.irisWebvmV86?.state?.().fipsStatus;
			return status?.state === 'ready' && status.ethernetPeers > 0;
		}),
		{ timeoutMs: 120_000, message: 'WebVM guest did not attach to browser FIPS Ethernet' },
	);

	await expect.poll(() => page.evaluate(
		() => globalThis.irisWebvmV86?.fipsHost?.pubsub,
	)).toBeUndefined();

	const shell = await runSerialCommand(page, 'shell readiness', "printf 'SHELL_READY\\n'");
	expect(shell).toContain('SHELL_READY');

	const output = await runSerialCommand(
		page,
		'normal network invite import',
		`webvm-pair '${invite}'`,
		90_000,
	);
	expect(output).toContain('Network invite imported.');
	expect(output).toContain('Join request is being sent to the admin over FIPS.');
	expect(output).toContain('Approve this WebVM on the admin device; the signed roster returns over FIPS.');

	const state = await runSerialCommand(
		page,
		'canonical pairing state',
		"for attempt in $(seq 1 60); do pid=$(pgrep -o nvpn || true); if [ -n \"$pid\" ] && grep -q '^\\[networks.outbound_join_request\\]' /var/lib/nvpn/config.toml && grep -q 'webvm-guest: awaiting signed roster over FIPS' /var/log/webvm-nvpn.log && ! test -e /run/webvm/pairing-uri && ! tr '\\0' ' ' </proc/$pid/cmdline | grep -Eq -- '--join-pubsub-port|--pairing-uri-file'; then printf 'CANONICAL_FIPS_PAIRING_OK\\n'; exit 0; fi; sleep 1; done; printf 'CANONICAL_FIPS_PAIRING_FAILED\\n'; exit 1",
		75_000,
	);
	expect(state).toContain('CANONICAL_FIPS_PAIRING_OK');
});
