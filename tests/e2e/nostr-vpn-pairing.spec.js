import { expect, test } from '@playwright/test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, SimplePool } from 'nostr-tools';
import { FIPS_ADVERT_KIND, FIPS_DEFAULT_DISCOVERY_APP } from '@fips/transport-webrtc';
import { networkInterface } from '../../src/lib/network.js';
import {
	assertCheerpXPacketBackendCapability,
	createEndpointDataBridge,
	getNostrVpnTransportStatus,
	inspectCheerpXPacketBackendCapability,
	NostrVpnPacketBackendUnavailableError,
	validatePacketBackend,
} from '../../src/lib/nostrVpnTransport.js';
import { createV86PacketBackend } from '../../src/lib/v86PacketBackend.js';

const FACT_OP_KIND = 7368;
const RECEIPT_TYPE = 'nostr_identity_device_approval_receipt';
const TEST_PROFILE_ID = '550e8400-e29b-41d4-a716-446655440000';

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

async function waitForRelayEvent(relayUrl, filter, predicate = () => true) {
	const pool = new SimplePool();
	try {
		return await new Promise((resolve, reject) => {
			let subscription;
			const timer = setTimeout(() => {
				subscription?.close?.();
				reject(new Error(`timed out waiting for relay event on ${relayUrl}`));
			}, 8_000);
			subscription = pool.subscribeMany(
				[relayUrl],
				filter,
				{
					onevent(event) {
						if (!predicate(event)) {
							return;
						}
						clearTimeout(timer);
						subscription?.close?.();
						resolve(event);
					},
				},
			);
		});
	} finally {
		pool.close([relayUrl]);
	}
}

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function buildNativeApprovalReceiptEvent(identity) {
	const signerSecretKey = generateSecretKey();
	const approvedByPubkey = getPublicKey(signerSecretKey);
	const approvedAt = Math.floor(Date.now() / 1000);
	const rosterOpId = '1'.repeat(64);
	const receipt = {
		schema: 1,
		profileId: TEST_PROFILE_ID,
		requestPubkey: identity.requestPubkeyHex,
		deviceAppKeyPubkey: identity.appPubkeyHex,
		approvedByPubkey,
		approvedAt,
		requestSecret: identity.requestSecret,
		subjectPubkey: null,
		rosterOpId,
		signedRosterEvent: JSON.stringify({
			id: rosterOpId,
			pubkey: approvedByPubkey,
			created_at: approvedAt,
			kind: FACT_OP_KIND,
			tags: [
				['type', 'identity_graph_roster'],
				['i', TEST_PROFILE_ID, 'subject'],
			],
			content: '{}',
			sig: '0'.repeat(128),
		}),
	};
	const conversationKey = nip44.v2.utils.getConversationKey(
		signerSecretKey,
		identity.requestPubkeyHex,
	);
	return finalizeEvent(
		{
			kind: FACT_OP_KIND,
			content: nip44.v2.encrypt(JSON.stringify(receipt), conversationKey),
			created_at: approvedAt,
			tags: [
				['type', RECEIPT_TYPE],
				['p', identity.requestPubkeyHex],
				['i', receipt.profileId, 'subject'],
			],
		},
		signerSecretKey,
	);
}

async function readInstalledCheerpXPackage() {
	const packageUrl = new URL('../../node_modules/@leaningtech/cheerpx/package.json', import.meta.url);
	const typesUrl = new URL('../../node_modules/@leaningtech/cheerpx/index.d.ts', import.meta.url);
	return {
		packageJson: JSON.parse(await readFile(packageUrl, 'utf8')),
		typeDeclarations: await readFile(typesUrl, 'utf8'),
	};
}

test('Nostr VPN fork does not expose the old Tailscale hash network interface', () => {
	expect(networkInterface).toBeUndefined();
});

test('Nostr VPN VM packet transport requires an explicit raw packet backend', () => {
	const status = getNostrVpnTransportStatus();
	expect(status).toMatchObject({
		state: 'packet-backend-unavailable',
		canRouteVmTraffic: false,
		connected: false,
	});
	expect(status.requiredMethods).toEqual(expect.arrayContaining([
		'onTxPacket(handler: (packet: Uint8Array) => void): () => void',
		'injectRxPacket(packet: Uint8Array): Promise<void> | void',
		'mtu: number',
	]));
	expect(() => validatePacketBackend({ mtu: 1200 })).toThrow(/onTxPacket/);
	expect(validatePacketBackend({
		mtu: 1200,
		onTxPacket: () => () => {},
		injectRxPacket: async () => {},
	})).toBeTruthy();
});

test('installed CheerpX package fails clearly without a raw packet NIC API', async () => {
	const { packageJson, typeDeclarations } = await readInstalledCheerpXPackage();
	const options = {
		packageName: packageJson.name,
		packageVersion: packageJson.version,
		typeDeclarations,
	};
	const report = inspectCheerpXPacketBackendCapability(options);

	expect(report).toMatchObject({
		available: false,
		package: `${packageJson.name}@${packageJson.version}`,
		controlPlaneFields: [
			'authKey',
			'controlUrl',
			'loginUrlCb',
			'stateUpdateCb',
			'netmapUpdateCb',
		],
		missingCapabilities: [
			'outboundPacketCallback',
			'inboundPacketInjection',
			'linkMetadata',
		],
	});
	expect(report.reason).toContain('raw packet/NIC API');
	expect(report.reason).toContain('no fallback networking');

	expect(() => assertCheerpXPacketBackendCapability(options))
		.toThrow(NostrVpnPacketBackendUnavailableError);
});

test('v86 packet backend maps net0 events to the Nostr VPN packet contract', () => {
	const listeners = new Map();
	const received = [];
	const emulator = {
		add_listener(event, listener) {
			listeners.set(event, listener);
		},
		remove_listener(event, listener) {
			if (listeners.get(event) === listener) {
				listeners.delete(event);
			}
		},
		bus: {
			send(event, packet) {
				received.push({ event, packet });
			},
		},
	};

	const backend = createV86PacketBackend(emulator, { mtu: 900 });
	const outbound = [];
	const stop = backend.onTxPacket((packet) => outbound.push(packet));
	const packet = new Uint8Array([1, 2, 3]);

	listeners.get('net0-send')(packet);
	backend.injectRxPacket(new Uint8Array([4, 5, 6]));
	stop();

	expect(backend.mtu).toBe(900);
	expect(outbound).toEqual([packet]);
	expect(received).toEqual([{ event: 'net0-receive', packet: new Uint8Array([4, 5, 6]) }]);
	expect(listeners.has('net0-send')).toBe(false);
});

test('endpoint-data bridge moves VM packets over the FIPS endpoint API', () => {
	let txHandler;
	let endpointHandler;
	const sent = [];
	const injected = [];
	const packetBackend = validatePacketBackend({
		mtu: 1200,
		onTxPacket(handler) {
			txHandler = handler;
			return () => {
				txHandler = null;
			};
		},
		injectRxPacket(packet) {
			injected.push(packet);
		},
	});
	const fipsNode = {
		sendEndpointData(args) {
			sent.push(args);
		},
		on(event, handler) {
			expect(event).toBe('endpointData');
			endpointHandler = handler;
			return () => {
				endpointHandler = null;
			};
		},
	};

	const stop = createEndpointDataBridge({ packetBackend, fipsNode, dst: 'peer-pubkey' });
	const txPacket = new Uint8Array([7, 8, 9]);
	const rxPacket = new Uint8Array([10, 11, 12]);

	txHandler(txPacket);
	endpointHandler({ payload: rxPacket });
	stop();

	expect(sent).toEqual([{ dst: 'peer-pubkey', payload: txPacket }]);
	expect(injected).toEqual([rxPacket]);
	expect(txHandler).toBeNull();
	expect(endpointHandler).toBeNull();
});

test('Nostr VPN join QR auto-detects native acceptance through a relay', async ({ page }) => {
	const relay = await startRelay();
	try {
		await page.goto('/');
		await page.getByTestId('sidebar-nostr-vpn').click();

		await expect(page.getByTestId('nostr-vpn-qr')).toHaveAttribute(
			'src',
			/^data:image\/png;base64,/,
		);
		const joinRequest = page.getByTestId('nostr-vpn-join-request');
		await expect(joinRequest).toContainText('nvpn://join-request/');
		await expect(page.getByText('Tailscale')).toHaveCount(0);

		const listenerStarted = await page.evaluate((relayUrl) => {
			return window.irisWebvmNostrVpn.startReceiptListener([relayUrl]);
		}, relay.url);
		expect(listenerStarted).toBe(true);

		const identity = await page.evaluate(() => {
			const raw = localStorage.getItem('iris-webvm.nostr-vpn.identity.v2');
			return JSON.parse(raw);
		});
		const receiptEvent = buildNativeApprovalReceiptEvent(identity);
		const pool = new SimplePool();
		try {
			await Promise.any(pool.publish([relay.url], receiptEvent, { maxWait: 5_000 }));
		} finally {
			pool.close([relay.url]);
		}

		await expect(page.getByTestId('nostr-vpn-pairing-status')).toHaveText('Paired');
		const accepted = await page.evaluate(() => {
			const identity = JSON.parse(localStorage.getItem('iris-webvm.nostr-vpn.identity.v2'));
			return {
			requestSecretLength: identity.requestSecret.length,
			link: window.irisWebvmNostrVpn.joinRequestLink(),
			paired: identity.paired,
			};
		});

		expect(accepted.requestSecretLength).toBeGreaterThanOrEqual(32);
		expect(accepted.link).toContain('nvpn://join-request/');
		expect(accepted.paired.profileId).toBe(TEST_PROFILE_ID);
		expect(accepted.paired.rosterOpId).toBe('1'.repeat(64));
		await expect(page.getByText('Native app accepted')).toBeVisible();
		await expect(page.getByText(TEST_PROFILE_ID)).toBeVisible();
		await expect(page.getByTestId('nostr-vpn-transport-status')).toContainText('FIPS transport ready');
		await expect.poll(
			() => page.evaluate(() => window.irisWebvmNostrVpn.transportStatus()),
			{ timeout: 10_000 },
		).toMatchObject({
			state: 'fips-ready-packet-backend-unavailable',
			canRouteVmTraffic: false,
			connected: false,
			xOnlyPubkeyHex: identity.appPubkeyHex,
		});
		const transportStatus = await page.evaluate(() => window.irisWebvmNostrVpn.transportStatus());
		const advertEvent = await waitForRelayEvent(
			relay.url,
			{
				kinds: [FIPS_ADVERT_KIND],
				authors: [identity.appPubkeyHex],
				'#d': [FIPS_DEFAULT_DISCOVERY_APP],
			},
			(event) => {
				const advert = JSON.parse(event.content);
				return advert.endpoints?.some((endpoint) => endpoint.addr === transportStatus.publicKeyHex);
			},
		);
		const advert = JSON.parse(advertEvent.content);

		expect(transportStatus).toMatchObject({
			state: 'fips-ready-packet-backend-unavailable',
			canRouteVmTraffic: false,
			connected: false,
			xOnlyPubkeyHex: identity.appPubkeyHex,
			relays: [relay.url],
		});
		expect(transportStatus.publicKeyHex).toHaveLength(66);
		expect(advertEvent.pubkey).toBe(identity.appPubkeyHex);
		expect(advertEvent.tags).toEqual(expect.arrayContaining([
			['d', FIPS_DEFAULT_DISCOVERY_APP],
			['protocol', FIPS_DEFAULT_DISCOVERY_APP],
			['version', '1'],
		]));
		expect(advert).toMatchObject({
			identifier: FIPS_DEFAULT_DISCOVERY_APP,
			version: 1,
			signalRelays: [relay.url],
			stunServers: [],
		});
		expect(advert.endpoints).toEqual([
			{
				transport: 'webrtc',
				addr: transportStatus.publicKeyHex,
			},
		]);
	} finally {
		await relay.stop();
	}
});
