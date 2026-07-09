import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const TEST_MESH_NETWORK_ID = '8d4f34f5425bc50e';
const TEST_NETWORK_NAME = 'Home';
const EXIT_DNS_IP = '1.1.1.1';
const EXIT_DNS_PORT = 53;
const EXIT_DNS_QUERY_ID = 0x4e56;
const EXIT_DNS_SOURCE_PORT = 53121;

async function availablePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => resolve(address.port));
		});
	});
}

async function waitForRelay(url) {
	const deadline = Date.now() + 10_000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const ws = new WebSocket(url);
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					ws.close();
					reject(new Error('relay open timed out'));
				}, 500);
				ws.onopen = () => {
					clearTimeout(timer);
					ws.close();
					resolve();
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error('relay connection failed'));
				};
			});
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError || new Error('relay did not start');
}

async function startRelay() {
	const port = await availablePort();
	const url = `ws://127.0.0.1:${port}`;
	const child = spawn('nak', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString();
	});
	try {
		await waitForRelay(url);
	} catch (error) {
		child.kill('SIGTERM');
		throw new Error(`${error.message}\n${stderr}`.trim());
	}
	return {
		url,
		async stop() {
			if (child.exitCode !== null) {
				return;
			}
			child.kill('SIGTERM');
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 1_000);
				child.once('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
}

function installMockV86(page) {
	return page.addInitScript(() => {
		window.__v86NativeNvpnTestState = {
			busSends: [],
			destroyed: false,
			fipsLogs: [],
			listeners: {},
			options: null,
		};
		window.irisWebvmV86TestHooks = {
			startFipsTransport(options) {
				const logger = {
					debug(...args) {
						window.__v86NativeNvpnTestState.fipsLogs.push({ level: 'debug', args: args.map(String) });
					},
					warn(...args) {
						window.__v86NativeNvpnTestState.fipsLogs.push({ level: 'warn', args: args.map(String) });
					},
				};
				return window.irisWebvmNostrVpn.startFipsTransport({ ...options, logger });
			},
			createV86(options) {
				window.__v86NativeNvpnTestState.options = {
					wasm_path: options.wasm_path,
					biosUrl: options.bios?.url,
					vgaBiosUrl: options.vga_bios?.url,
					bzimageUrl: options.bzimage?.url,
					cmdline: options.cmdline,
					netDevice: options.net_device,
				};
				const emulator = {
					add_listener(event, listener) {
						window.__v86NativeNvpnTestState.listeners[event] ||= [];
						window.__v86NativeNvpnTestState.listeners[event].push(listener);
						if (event === 'emulator-ready' || event === 'emulator-started') {
							setTimeout(() => listener(), 0);
						}
					},
					remove_listener(event, listener) {
						window.__v86NativeNvpnTestState.listeners[event] = (
							window.__v86NativeNvpnTestState.listeners[event] || []
						).filter((candidate) => candidate !== listener);
					},
					bus: {
						send(event, packet) {
							window.__v86NativeNvpnTestState.busSends.push({
								event,
								packet: Array.from(packet || []),
							});
						},
					},
					destroy() {
						window.__v86NativeNvpnTestState.destroyed = true;
					},
				};
				window.__v86NativeNvpnTestState.emulator = emulator;
				return emulator;
			},
		};
	});
}

function parseIpv4Address(address) {
	const octets = String(address).split('.').map((part) => Number.parseInt(part, 10));
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		throw new Error(`invalid IPv4 address: ${address}`);
	}
	return octets;
}

function ipv4Checksum(header) {
	let sum = 0;
	for (let i = 0; i < header.length; i += 2) {
		sum += (header[i] << 8) + (header[i + 1] || 0);
		while (sum > 0xffff) {
			sum = (sum & 0xffff) + (sum >>> 16);
		}
	}
	return (~sum) & 0xffff;
}

function dnsQueryPayload() {
	const name = 'example.com'.split('.');
	const labels = name.flatMap((part) => [part.length, ...new TextEncoder().encode(part)]);
	return new Uint8Array([
		EXIT_DNS_QUERY_ID >> 8,
		EXIT_DNS_QUERY_ID & 0xff,
		0x01,
		0x00,
		0x00,
		0x01,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		...labels,
		0x00,
		0x00,
		0x01,
		0x00,
		0x01,
	]);
}

function ipv4UdpEthernetFrame({ sourceIp, destinationIp, sourcePort, destinationPort, payload }) {
	const ipHeaderLength = 20;
	const udpLength = 8 + payload.length;
	const totalLength = ipHeaderLength + udpLength;
	const frame = new Uint8Array(14 + totalLength);
	frame.set([0x02, 0x00, 0x5e, 0x10, 0x44, 0x01], 0);
	frame.set([0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee], 6);
	frame[12] = 0x08;
	frame[13] = 0x00;
	const ip = frame.subarray(14);
	ip[0] = 0x45;
	ip[2] = totalLength >> 8;
	ip[3] = totalLength & 0xff;
	ip[6] = 0x40;
	ip[8] = 64;
	ip[9] = 17;
	frame.set(parseIpv4Address(sourceIp), 26);
	frame.set(parseIpv4Address(destinationIp), 30);
	const checksum = ipv4Checksum(ip.subarray(0, ipHeaderLength));
	ip[10] = checksum >> 8;
	ip[11] = checksum & 0xff;
	const udpOffset = 14 + ipHeaderLength;
	frame[udpOffset] = sourcePort >> 8;
	frame[udpOffset + 1] = sourcePort & 0xff;
	frame[udpOffset + 2] = destinationPort >> 8;
	frame[udpOffset + 3] = destinationPort & 0xff;
	frame[udpOffset + 4] = udpLength >> 8;
	frame[udpOffset + 5] = udpLength & 0xff;
	frame.set(payload, udpOffset + 8);
	return Array.from(frame);
}

function bytesToHex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseIpv4UdpFromEthernet(frame) {
	if (!Array.isArray(frame) || frame.length < 42 || frame[12] !== 0x08 || frame[13] !== 0x00) {
		return null;
	}
	const ip = frame.slice(14);
	if ((ip[0] >> 4) !== 4 || ip[9] !== 17) {
		return null;
	}
	const headerLength = (ip[0] & 0x0f) * 4;
	const udpOffset = 14 + headerLength;
	return {
		sourceIp: frame.slice(14 + 12, 14 + 16).join('.'),
		destinationIp: frame.slice(14 + 16, 14 + 20).join('.'),
		sourcePort: (frame[udpOffset] << 8) | frame[udpOffset + 1],
		destinationPort: (frame[udpOffset + 2] << 8) | frame[udpOffset + 3],
		payload: frame.slice(udpOffset + 8),
	};
}

function defaultNativeHelperManifest() {
	return path.resolve(process.cwd(), '../nostr-vpn/crates/nostr-vpn-app-core/Cargo.toml');
}

function startNativeHelper({ relayUrl, joinRequest }) {
	const manifest = process.env.NVPN_APP_CORE_MANIFEST || defaultNativeHelperManifest();
	if (!existsSync(manifest)) {
		throw new Error(`Nostr VPN app-core manifest not found: ${manifest}`);
	}
	const cargo = process.env.CARGO || 'cargo';
	const args = [
		'run',
		'--quiet',
		'--manifest-path',
		manifest,
		'--example',
		'webvm_native_fips_e2e',
		'--',
		'--relay',
		relayUrl,
		'--join-request',
		joinRequest,
		'--mesh-network-id',
		TEST_MESH_NETWORK_ID,
		'--network-name',
		TEST_NETWORK_NAME,
		'--timeout-ms',
		'90000',
	];
	const child = spawn(cargo, args, {
		cwd: path.dirname(manifest),
		env: {
			...process.env,
			RUST_LOG: process.env.RUST_LOG || 'warn',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdoutBuffer = '';
	let stderr = '';
	const events = [];
	const waiters = new Set();

	function wakeWaiters() {
		for (const waiter of waiters) {
			waiter.check();
		}
	}

	child.stdout.on('data', (chunk) => {
		stdoutBuffer += chunk.toString();
		for (;;) {
			const newline = stdoutBuffer.indexOf('\n');
			if (newline === -1) {
				break;
			}
			const line = stdoutBuffer.slice(0, newline).trim();
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			try {
				events.push(JSON.parse(line));
				wakeWaiters();
			} catch {
				events.push({ type: 'stdout', line });
				wakeWaiters();
			}
		}
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString();
	});
	child.once('exit', (code, signal) => {
		for (const waiter of waiters) {
			waiter.reject(new Error(`native helper exited before expected event: code=${code} signal=${signal}\n${stderr}`));
		}
		waiters.clear();
	});

	return {
		child,
		events() {
			return [...events];
		},
		waitFor(predicate, timeoutMs = 30_000) {
			const existing = events.find(predicate);
			if (existing) {
				return Promise.resolve(existing);
			}
			return new Promise((resolve, reject) => {
				const waiter = {
					check() {
						const event = events.find(predicate);
						if (!event) {
							return;
						}
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
					reject(new Error(`timed out waiting for native helper event\nstdout=${JSON.stringify(events)}\nstderr=${stderr}`));
				}, timeoutMs);
				waiters.add(waiter);
			});
		},
		async stop() {
			if (child.exitCode !== null) {
				return;
			}
			child.kill('SIGTERM');
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 1_000);
				child.once('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
}

async function sendFrameUntilReceived({ page, native, frame, expectedPayloadHex }) {
	let received = false;
	const receivedEvent = native.waitFor((event) => {
		if (event.type !== 'endpoint-data' || event.payloadHex !== expectedPayloadHex) {
			return false;
		}
		received = true;
		return true;
	}, 60_000);
	for (let attempt = 0; attempt < 60 && !received; attempt += 1) {
		await page.evaluate((frameBytes) => {
			const listener = window.__v86NativeNvpnTestState.listeners['net0-send']?.[0];
			if (!listener) {
				throw new Error('v86 net0-send listener is not registered');
			}
			listener(new Uint8Array(frameBytes));
		}, frame);
		await Promise.race([
			receivedEvent.then(() => {}),
			new Promise((resolve) => setTimeout(resolve, 500)),
		]);
	}
	return receivedEvent;
}

async function waitForPacketBridgeReady(page, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let state = null;
	let transportStatus = null;
	while (Date.now() < deadline) {
		({ state, transportStatus } = await page.evaluate(() => ({
			state: window.irisWebvmV86.state(),
			transportStatus: window.irisWebvmNostrVpn.transportStatus(),
		})));
		if (state.bridgeSummary === 'Nostr VPN packet bridge ready') {
			return { state, transportStatus };
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	const fipsLogs = await page.evaluate(() => window.__v86NativeNvpnTestState.fipsLogs);
	throw new Error(
		`v86 route did not attach the real Nostr VPN packet bridge\nstate=${JSON.stringify(state, null, 2)}\ntransport=${JSON.stringify(transportStatus, null, 2)}\nfipsLogs=${JSON.stringify(fipsLogs, null, 2)}`,
	);
}

async function waitForVmDnsResponse({ page, guestIp, timeoutMs = 30_000 }) {
	const deadline = Date.now() + timeoutMs;
	let observed = null;
	let busSummary = null;
	while (Date.now() < deadline) {
		const busSends = await page.evaluate(() => window.__v86NativeNvpnTestState.busSends);
		busSummary = busSends.map((send) => ({
			event: send.event,
			length: send.packet?.length || 0,
			ethertype: send.packet?.length >= 14
				? `0x${(((send.packet[12] << 8) | send.packet[13]).toString(16)).padStart(4, '0')}`
				: '',
			ipProtocol: send.packet?.length >= 24 ? send.packet[23] : null,
			sourceIp: send.packet?.length >= 34 ? send.packet.slice(26, 30).join('.') : '',
			destinationIp: send.packet?.length >= 34 ? send.packet.slice(30, 34).join('.') : '',
		}));
		for (const send of busSends) {
			if (send.event !== 'net0-receive') {
				continue;
			}
			const parsed = parseIpv4UdpFromEthernet(send.packet);
			if (
				parsed
				&& parsed.sourceIp === EXIT_DNS_IP
				&& parsed.destinationIp === guestIp
				&& parsed.sourcePort === EXIT_DNS_PORT
				&& parsed.destinationPort === EXIT_DNS_SOURCE_PORT
				&& parsed.payload[0] === (EXIT_DNS_QUERY_ID >> 8)
				&& parsed.payload[1] === (EXIT_DNS_QUERY_ID & 0xff)
			) {
				observed = {
					...parsed,
					queryId: (parsed.payload[0] << 8) | parsed.payload[1],
					isResponse: Boolean(parsed.payload[2] & 0x80),
					answerCount: (parsed.payload[6] << 8) | parsed.payload[7],
				};
				if (observed.isResponse) {
					return observed;
				}
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const bridgeDebug = await page.evaluate(() => globalThis.irisWebvmNostrVpnBridgeDebug || null);
	throw new Error(
		`timed out waiting for DNS response at VM NIC; observed=${JSON.stringify(observed)}; bus=${JSON.stringify(busSummary)}; bridge=${JSON.stringify(bridgeDebug)}`,
	);
}

test('WebVM pairs from native Nostr VPN approval and routes DNS over a real exit node', async ({ page }) => {
	test.setTimeout(240_000);

	const relay = await startRelay();
	let native;
	try {
		await installMockV86(page);
		await page.goto('/v86');
		await expect(page.getByTestId('nostr-vpn-qr')).toHaveAttribute('src', /^data:image\/png;base64,/);
		await expect(page.getByTestId('nostr-vpn-join-request')).toContainText('nvpn://join-request/');
		await expect(page.getByText('Tailscale')).toHaveCount(0);

		const listenerStarted = await page.evaluate((relayUrl) => {
			return window.irisWebvmNostrVpn.startReceiptListener([relayUrl]);
		}, relay.url);
		expect(listenerStarted).toBe(true);
		const joinRequest = await page.evaluate(() => window.irisWebvmNostrVpn.joinRequestLink());
		const browserIdentity = await page.evaluate(() => {
			return JSON.parse(localStorage.getItem('iris-webvm.nostr-vpn.identity.v2'));
		});

		native = startNativeHelper({ relayUrl: relay.url, joinRequest });
		const parsedJoinRequest = await native.waitFor((event) => event.type === 'join-request-parsed', 30_000);
		expect(parsedJoinRequest.hasRequestSecret).toBe(true);
		expect(parsedJoinRequest.requestPubkey).toMatch(/^[0-9a-f]{64}$/);
		expect(parsedJoinRequest.deviceAppKeyPubkey).toBe(browserIdentity.appPubkeyHex);
		const nativeReady = await native.waitFor((event) => event.type === 'ready', 120_000);
		expect(nativeReady.adminPubkeyHex).toMatch(/^[0-9a-f]{64}$/);

		await expect(page.getByTestId('nostr-vpn-pairing-status')).toHaveText('Paired', {
			timeout: 60_000,
		});
		await expect.poll(
			() => page.evaluate(() => {
				return JSON.parse(localStorage.getItem('iris-webvm.nostr-vpn.identity.v2')).paired;
			}),
			{
				timeout: 60_000,
				message: 'native approval context should provide the Nostr VPN mesh id',
			},
		).toMatchObject({
			meshNetworkId: TEST_MESH_NETWORK_ID,
			networkName: TEST_NETWORK_NAME,
			adminPubkeyHex: nativeReady.adminPubkeyHex,
		});
		const paired = await page.evaluate(() => {
			return JSON.parse(localStorage.getItem('iris-webvm.nostr-vpn.identity.v2')).paired;
		});
		await waitForPacketBridgeReady(page);
		await expect(page.getByTestId('v86-backend-status')).toContainText('Guest IP');

		const status = await page.evaluate(() => window.irisWebvmNostrVpn.transportStatus());
		expect(status).toMatchObject({
			state: 'fips-packet-bridge-ready',
			canRouteVmTraffic: true,
			packetBridgeAttached: true,
		});
		expect(paired.meshNetworkId).toBe(TEST_MESH_NETWORK_ID);
		expect(paired.networkName).toBe(TEST_NETWORK_NAME);
		expect(paired.adminPubkeyHex).toBe(nativeReady.adminPubkeyHex);
		const routeState = await page.evaluate(() => window.irisWebvmV86.state());

		const frame = ipv4UdpEthernetFrame({
			sourceIp: routeState.backendStatus.guestIp,
			destinationIp: EXIT_DNS_IP,
			sourcePort: EXIT_DNS_SOURCE_PORT,
			destinationPort: EXIT_DNS_PORT,
			payload: dnsQueryPayload(),
		});
		const expectedPayloadHex = bytesToHex(frame.slice(14));
		let received;
		try {
			received = await sendFrameUntilReceived({
				page,
				native,
				frame,
				expectedPayloadHex,
			});
		} catch (error) {
			const bridgeDebug = await page.evaluate(() => globalThis.irisWebvmNostrVpnBridgeDebug || null);
			throw new Error(`${error instanceof Error ? error.message : String(error)}\nbridge=${JSON.stringify(bridgeDebug, null, 2)}`);
		}
		const exitResponse = await native.waitFor(
			(event) => event.type === 'exit-udp-response' && event.target === `${EXIT_DNS_IP}:${EXIT_DNS_PORT}`,
			30_000,
		);
		let vmDnsResponse;
		try {
			vmDnsResponse = await waitForVmDnsResponse({
				page,
				guestIp: routeState.backendStatus.guestIp,
			});
		} catch (error) {
			const fipsLogs = await page.evaluate(() => window.__v86NativeNvpnTestState.fipsLogs);
			throw new Error(`${error instanceof Error ? error.message : String(error)}\nnative=${JSON.stringify(native.events(), null, 2)}\nfipsLogs=${JSON.stringify(fipsLogs, null, 2)}`);
		}

		expect(received.sourcePeerNpub).toMatch(/^npub/);
		expect(received.payloadHex).toBe(expectedPayloadHex);
		expect(exitResponse.responseBytes).toBeGreaterThan(0);
		expect(vmDnsResponse.answerCount).toBeGreaterThan(0);
	} finally {
		await native?.stop();
		await relay.stop();
	}
});
