import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { inspectNativeFixture } from '../../scripts/native-fixture.mjs';
import {
	exitAdminStatus,
	normalizedPubkey,
	recipientFromJoinRequest,
	removeNewOutboxEntries,
	runExitAdmin,
	snapshotOutbox,
	stageExitAdminConfig,
	stageLiveExitApproval,
	startExitAdminService,
	stopExitAdminService,
} from './helpers/webvm-exit-admin.js';
import { waitForGuestNvpnDaemon } from './helpers/webvm-daemon-readiness.js';
import { waitForAutomaticPrivateExit } from './helpers/webvm-exit-readiness.js';
import { waitForPrivateExitInternet } from './helpers/webvm-internet-readiness.js';
import { parseSerialCommandResult } from './helpers/webvm-serial-command.js';
import { runStandardApproval } from './helpers/webvm-standard-approval.js';

const REAL_E2E_ENABLED = process.env.NVPN_WEBVM_REAL_E2E === '1';
const EXIT_ADMIN_CONFIG = process.env.NVPN_WEBVM_EXIT_ADMIN_CONFIG?.trim();
const EXIT_ADMIN_EXCLUSIVE = process.env.NVPN_WEBVM_EXIT_ADMIN_EXCLUSIVE === '1';
const SERIAL_BUFFER_LIMIT = 128 * 1024;
let serialCommandTail = Promise.resolve();
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

function runSerialCommand(page, label, command, timeoutMs = 60_000) {
	const result = serialCommandTail.then(() => (
		runSerialCommandUnlocked(page, label, command, timeoutMs)
	));
	serialCommandTail = result.catch(() => {});
	return result;
}

async function runSerialCommandUnlocked(page, label, command, timeoutMs) {
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
	try {
		await waitUntil(
			async () => {
				const serial = await page.evaluate(
					() => globalThis.__nvpnStandardE2eSerial?.text || '',
				);
				result = parseSerialCommandResult(serial, begin, end);
				return Boolean(result);
			},
			{ timeoutMs, message: `serial command timed out during ${label}` },
		);
	} catch (error) {
		const serial = await page.evaluate(() => globalThis.__nvpnStandardE2eSerial?.text || '');
		throw new Error(`${error.message}: ${serial.replaceAll('\r', '').slice(-12_000)}`);
	}
	if (result.status !== 0) {
		throw new Error(`serial command failed during ${label}: ${result.output.join(' | ')}`);
	}
	return result.output;
}

async function guestRosterApplied(page, label = 'signed-roster application check') {
	try {
		await runSerialCommand(
			page,
			label,
			"! grep -q '^local_identity_confirmation_pending = true$' /var/lib/nvpn/config.toml " +
				"&& grep -q '^shared_roster_signed_by = ' /var/lib/nvpn/config.toml",
			30_000,
		);
		return true;
	} catch {
		return false;
	}
}

async function guestApprovalPathReady(page) {
	try {
		await runSerialCommand(
			page,
			'guest FIPS approval-path readiness probe',
			"nvpn join-request --no-qr --no-wait 2>&1 | " +
				"grep -Fq 'FIPS connection active; approval can be delivered'",
			10_000,
		);
		return true;
	} catch {
		return false;
	}
}

async function ensureBrowserPeerRoute(page, peer, { restartExisting = false } = {}) {
	return page.evaluate(async ({ expectedPeer, restartExistingPeer }) => {
		const host = globalThis.irisWebvmV86?.fipsHost;
		const transport = host?.webrtc;
		const connections = transport?.conns instanceof Map ? [...transport.conns.keys()] : [];
		const connection = connections.find((candidate) => (
			candidate.toLowerCase().endsWith(expectedPeer)
		));
		if (connection && restartExistingPeer) {
			await transport.handlePeerRestart(connection);
		} else if (!connection) {
			const adverts = transport?.advertCache?.values
				? [...transport.advertCache.values()]
				: [];
			const advertisedAddress = adverts
				.map((advert) => advert?.peer?.remoteAddr?.addr)
				.find((candidate) => (
					typeof candidate === 'string'
						&& candidate.toLowerCase().endsWith(expectedPeer)
				));
			if (advertisedAddress) {
				try {
					await transport.connect({ transport: 'webrtc', addr: advertisedAddress });
				} catch {
					// The bounded guest readiness loop will retry after fresh discovery.
				}
			}
		}
		host?.pubsub?.refreshPeers?.();
		return Boolean(connection);
	}, { expectedPeer: peer, restartExistingPeer: restartExisting });
}

async function approveAndWaitForGuestRoster({ fixture, request, dataDir, page }) {
	const attempts = Number.parseInt(process.env.NVPN_STANDARD_APPROVAL_ATTEMPTS || '3', 10);
	if (!Number.isInteger(attempts) || attempts < 1)
		throw new Error('NVPN_STANDARD_APPROVAL_ATTEMPTS must be a positive integer');
	const approvalEvents = [];
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		approvalEvents.push(...await runStandardApproval({
			fixture,
			request,
			dataDir,
			isGuestRosterApplied: () => guestRosterApplied(
				page, `concurrent signed-roster attempt ${attempt}`,
			),
		}));
		if (await guestRosterApplied(page, `signed-roster attempt ${attempt}`)) {
			return [
				...approvalEvents,
				{
					ok: true,
					event: 'delivered',
					recipient: recipientFromJoinRequest(request),
				},
			];
		}
		if (attempt === attempts) {
			throw new Error(
				`signed roster was not applied after ${attempts} delivery attempts\n` +
					approvalEvents.map((event) => JSON.stringify(event)).join('\n'),
			);
		}
	}
	throw new Error('signed roster approval attempts unexpectedly exhausted');
}
test('ordinary nVPN pairing crosses WSS and can use its approving FIPS exit', async ({ page }) => {
	test.setTimeout(1_200_000);
	const browserFipsLogs = [];
	page.on('console', (message) => {
		const text = message.text();
		if (!/fips|lookup|session|websocket|ethernet/iu.test(text)) return;
		browserFipsLogs.push(`${message.type()}: ${text}`);
		if (browserFipsLogs.length > 200) browserFipsLogs.shift();
	});
	const fixture = inspectNativeFixture();
	const dataDir = mkdtempSync(path.join(tmpdir(), 'nvpn-standard-join-e2e-'));
	const exitAdmin = EXIT_ADMIN_CONFIG ? {
		binary: path.resolve(process.env.NVPN_WEBVM_EXIT_ADMIN_BIN?.trim() || fixture.binary),
		config: path.resolve(EXIT_ADMIN_CONFIG),
	} : null;
	let joinedRecipient = '';
	let expectedExit = '';
	let exitOutboxBefore = new Set();
	let exitServiceStopped = false;
	if (exitAdmin) {
		const status = exitAdminStatus(exitAdmin.binary, exitAdmin.config);
		expect(status.advertise_exit_node).toBe(true);
		expect(status.wireguard_exit?.enabled).toBe(false);
		expect(status.wireguard_exit?.configured).toBe(false);
		expectedExit = normalizedPubkey(status.device_id);
		exitOutboxBefore = snapshotOutbox(exitAdmin.config);
		if (EXIT_ADMIN_EXCLUSIVE) stageExitAdminConfig(exitAdmin.config, dataDir);
	}
	await page.goto('/v86?webvm-e2e=1');
	await attachSerial(page);
	try {
		await waitUntil(
			() => page.evaluate(() => globalThis.irisWebvmV86?.state?.().terminalReady === true),
			{ timeoutMs: 120_000, message: 'WebVM shell did not become ready' },
		);
		await waitForGuestNvpnDaemon({ page, runSerialCommand });
		const output = await runSerialCommand(
			page,
			'normal nVPN join request',
			"! grep -q -- '--webvm-' /usr/local/sbin/webvm-nvpn " +
				"&& grep -qF -- '--fips-ethernet-interface' /usr/local/sbin/webvm-nvpn " +
				"&& grep -qF -- '--fips-ethernet-discovery-scope' /usr/local/sbin/webvm-nvpn " +
				'&& ! nvpn webvm-guest --help >/dev/null 2>&1 ' +
				"&& for i in $(seq 1 12); do output=$(nvpn join-request --no-qr --no-wait 2>&1) " +
				'&& { printf \'%s\\n\' "$output"; exit 0; }; sleep 2; done; ' +
				'printf \'%s\\n\' "$output"; exit 1',
			90_000,
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
		await waitUntil(
			() => page.evaluate(() => {
				const status = globalThis.irisWebvmV86?.state?.().fipsStatus;
				return (status?.websocketPeers || 0) > 0
					&& (status?.ethernetPeers || 0) > 0;
			}),
			{
				timeoutMs: 120_000,
				message: 'ordinary nVPN approval topology did not become ready',
			},
		);

		let approvalEvents;
		try {
			await waitUntil(
				() => guestApprovalPathReady(page),
				{
					timeoutMs: 180_000,
					intervalMs: 2_000,
					message: 'ordinary nVPN guest did not establish an approval delivery path',
				},
			);
			if (exitAdmin && EXIT_ADMIN_EXCLUSIVE) {
				stopExitAdminService();
				exitServiceStopped = true;
				try {
					approvalEvents = await approveAndWaitForGuestRoster({
						fixture, request, dataDir, page,
					});
				} finally {
					startExitAdminService();
					exitServiceStopped = false;
				}
				await waitUntil(
					() => exitAdminStatus(exitAdmin.binary, exitAdmin.config).daemon?.running === true,
					{ timeoutMs: 60_000, intervalMs: 1_000, message: 'exit admin did not restart' },
				);
				joinedRecipient = approvalEvents.find((event) => (
					event.ok === true && event.event === 'approved'
				))?.recipient || '';
				runExitAdmin(exitAdmin.binary, exitAdmin.config, [
					'add-device', '--device', joinedRecipient, '--json',
				]);
				runExitAdmin(exitAdmin.binary, exitAdmin.config, ['reload']);
			} else if (exitAdmin) {
				joinedRecipient = recipientFromJoinRequest(request);
				stageLiveExitApproval({
					fixture,
					request,
					config: exitAdmin.config,
					dataDir,
				});
				runExitAdmin(exitAdmin.binary, exitAdmin.config, ['reload']);
				stageExitAdminConfig(exitAdmin.config, dataDir);
				stopExitAdminService();
				exitServiceStopped = true;
				try {
					approvalEvents = await approveAndWaitForGuestRoster({
						fixture, request, dataDir, page,
					});
				} finally {
					startExitAdminService();
					exitServiceStopped = false;
				}
				await waitUntil(
					() => exitAdminStatus(exitAdmin.binary, exitAdmin.config).daemon?.running === true,
					{ timeoutMs: 60_000, intervalMs: 1_000, message: 'exit admin did not restart' },
				);
				await ensureBrowserPeerRoute(page, expectedExit, { restartExisting: true });
			} else {
				approvalEvents = await runStandardApproval({
					fixture,
					request,
					dataDir,
					isGuestRosterApplied: () => guestRosterApplied(page),
				});
			}
		} catch (error) {
			let guest;
			try {
				guest = await runSerialCommand(
					page,
					'nVPN approval diagnostics',
					"echo __JOIN__; nvpn join-request --no-qr --no-wait 2>&1 || true; " +
						"echo __STATE__; cat /var/lib/nvpn/daemon.state.json 2>&1 || true; echo __LOG__; " +
						"cat /var/lib/nvpn/daemon.log 2>&1 || true",
					90_000,
				);
			} catch (diagnosticError) {
				guest = [`diagnostics failed: ${diagnosticError.message}`];
			}
			const browser = await page.evaluate(() => ({
				frames: globalThis.irisWebvmV86?.fipsHost?.ethernetFrameStats,
				pubsub: globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats,
				state: globalThis.irisWebvmV86?.state?.(),
			}));
			throw new Error(
				`${error.message}\nGuest:\n${guest.join('\n')}` +
					`\nBrowser:\n${JSON.stringify(browser)}` +
					`\nBrowser FIPS log:\n${browserFipsLogs.join('\n')}`,
			);
		}
		expect(approvalEvents).toEqual(expect.arrayContaining([
			expect.objectContaining({ ok: true, event: 'approved' }),
		]));
		expect(approvalEvents).toEqual(expect.arrayContaining([
			expect.objectContaining({ event: 'delivered', ok: true }),
		]));
		if (exitAdmin) {
			expect(joinedRecipient).toMatch(/^[0-9a-f]{64}$/u);
		}
		const approved = await runSerialCommand(
			page,
			'normal signed-roster approval',
			"for i in $(seq 1 120); do " +
				"! grep -q '^local_identity_confirmation_pending = true$' /var/lib/nvpn/config.toml " +
				"&& grep -q '^shared_roster_signed_by = ' /var/lib/nvpn/config.toml " +
				"&& exit 0; sleep 1; done; " +
			"grep -E '^(internet_source|local_identity_confirmation_pending|shared_roster_signed_by) = ' " +
				"/var/lib/nvpn/config.toml; nvpn join-request --no-qr --no-wait; exit 1",
			150_000,
		);
		expect(approved).toEqual([]);

		if (exitAdmin) {
			await waitForAutomaticPrivateExit({
				page,
				expectedExit,
				runSerialCommand,
				refreshExitPeerRoute: () => ensureBrowserPeerRoute(page, expectedExit),
			});
			try {
				await waitForPrivateExitInternet({ page, runSerialCommand });
			} catch (error) {
				const guest = await runSerialCommand(
					page,
					'private exit diagnostics',
					"echo __ENV__; pid=$(sed -n 's/.*\"pid\": \\([0-9]*\\).*/\\1/p' " +
					"/var/lib/nvpn/daemon.pid); tr '\\0' '\\n' </proc/$pid/environ " +
						"| grep '^NVPN_FIPS_LINUX_TUN_GRO=' || true; echo __LINKS__; " +
						"ip -s link show dev eth0; ip -s link show dev nvpn0; echo __ROUTES__; " +
						"ip -4 route; ip route get 1.1.1.1; echo __DNS__; cat /etc/resolv.conf; " +
						"ss -lunt; nvpn status --json --config /var/lib/nvpn/config.toml || true; " +
						"echo __MANGLE__; " +
						"iptables -t mangle -L OUTPUT -n -v 2>&1 || true; echo __LOG__; " +
						"tail -n 200 /var/lib/nvpn/daemon.log 2>&1 || true; true",
					30_000,
				);
				const browser = await page.evaluate(() => ({
					frames: globalThis.irisWebvmV86?.fipsHost?.ethernetFrameStats,
					pubsub: globalThis.irisWebvmV86?.fipsHost?.pubsub?.stats,
					state: globalThis.irisWebvmV86?.state?.(),
				}));
				throw new Error(
					`${error.message}\nGuest:\n${guest.join('\n')}` +
						`\nBrowser:\n${JSON.stringify(browser)}`,
				);
			}
		}

		const stats = await page.evaluate(() => globalThis.irisWebvmV86.fipsHost.pubsub.stats);
		expect(stats.subscriptionBatches).toBeGreaterThan(0);
		expect(stats.relaySubscriptions).toBeGreaterThan(0);
		expect(stats.relayEvents).toBeGreaterThan(0);
		expect(stats.flushedDeferredRelayEvents).toBeGreaterThan(0);
		expect(stats.deferredRelayEvents).toBeLessThanOrEqual(64);
		expect(stats.serviceErrors).toBe(0);
		expect(Object.keys(stats).some((key) => /approval|stateControl/u.test(key))).toBe(false);
	} finally {
		if (exitServiceStopped) {
			try {
				startExitAdminService();
				exitServiceStopped = false;
			} catch (error) {
				console.error(`failed to restart exit admin service: ${error.message}`);
			}
		}
		if (exitAdmin && joinedRecipient) {
			try {
				runExitAdmin(exitAdmin.binary, exitAdmin.config, [
					'remove-device', '--device', joinedRecipient, '--json',
				]);
				runExitAdmin(exitAdmin.binary, exitAdmin.config, ['reload']);
			} catch (error) {
				console.error(`failed to remove temporary WebVM device: ${error.message}`);
			}
			try {
				removeNewOutboxEntries(exitAdmin.config, exitOutboxBefore);
			} catch (error) {
				console.error(`failed to remove temporary WebVM approval: ${error.message}`);
			}
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
});
