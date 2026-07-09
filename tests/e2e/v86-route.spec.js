import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'iris-webvm.nostr-vpn.identity.v2';
const TEST_PROFILE_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MESH_NETWORK_ID = '8d4f34f5425bc50e';

function installMockV86(page, { paired = false, fipsMode = 'ready', includeMeshContext = true } = {}) {
	return page.addInitScript(({ storageKey, profileId, meshNetworkId, pairedValue, mode, hasMeshContext }) => {
		function makeIdentity() {
			return {
				appSecretKeyHex: '1'.repeat(64),
				appPubkeyHex: 'a'.repeat(64),
				requestSecretKeyHex: '2'.repeat(64),
				requestPubkeyHex: 'b'.repeat(64),
				requestSecret: 'request-secret-for-v86-route-tests-0001',
				requestedAt: 1_720_000_000,
				nodeName: 'Iris WebVM test',
				createdAt: '2026-07-09T00:00:00.000Z',
				paired: pairedValue
					? {
							pairedAt: '2026-07-09T00:01:00.000Z',
							adminNpub: 'npub1test',
							adminPubkeyHex: 'c'.repeat(64),
							networkName: 'Home',
							profileId,
							rosterOpId: '1'.repeat(64),
							...(hasMeshContext ? { meshNetworkId } : {}),
						}
					: null,
			};
		}

		localStorage.setItem(storageKey, JSON.stringify(makeIdentity()));
		window.__v86RouteTestState = {
			busSends: [],
			destroyed: false,
			fipsCalls: [],
			listeners: {},
			options: null,
			txPackets: [],
		};
		window.irisWebvmV86TestHooks = {
			createV86(options) {
				window.__v86RouteTestState.options = {
					wasm_path: options.wasm_path,
					biosUrl: options.bios?.url,
					vgaBiosUrl: options.vga_bios?.url,
					bzimageUrl: options.bzimage?.url,
					cmdline: options.cmdline,
					netDevice: options.net_device,
					hasScreenContainer: Boolean(options.screen?.container),
					hasSerialContainer: Boolean(options.serial_container),
				};
				const emulator = {
					add_listener(event, listener) {
						window.__v86RouteTestState.listeners[event] ||= [];
						window.__v86RouteTestState.listeners[event].push(listener);
						if (event === 'emulator-ready') {
							setTimeout(() => listener(), 0);
						}
						if (event === 'emulator-started') {
							setTimeout(() => listener(), 0);
						}
					},
					remove_listener(event, listener) {
						window.__v86RouteTestState.listeners[event] = (
							window.__v86RouteTestState.listeners[event] || []
						).filter((candidate) => candidate !== listener);
					},
					bus: {
						send(event, packet) {
							window.__v86RouteTestState.busSends.push({
								event,
								packet: Array.from(packet || []),
							});
						},
					},
					destroy() {
						window.__v86RouteTestState.destroyed = true;
					},
				};
				window.__v86RouteTestState.emulator = emulator;
				return emulator;
			},
			startFipsTransport({ packetBackend }) {
				const backendStatus = packetBackend.status?.() || null;
				window.__v86RouteTestState.fipsCalls.push({
					hasPacketBackend: Boolean(packetBackend),
					mtu: packetBackend?.mtu,
					backendStatus,
				});
				if (mode === 'missing-context') {
					throw new Error('packet bridge requires native mesh context');
				}
				packetBackend.onTxPacket((packet) => {
					window.__v86RouteTestState.txPackets.push(Array.from(packet));
				});
				return {
					state: 'fips-packet-bridge-ready',
					canRouteVmTraffic: true,
					connected: false,
					summary: 'FIPS transport ready',
					packetBridgeAttached: true,
				};
			},
		};
	}, {
		storageKey: STORAGE_KEY,
		profileId: TEST_PROFILE_ID,
		meshNetworkId: TEST_MESH_NETWORK_ID,
		pairedValue: paired,
		mode: fipsMode,
		hasMeshContext: includeMeshContext,
	});
}

function ipv4EthernetFrame() {
	const frame = new Uint8Array(14 + 20);
	frame.set([0x02, 0x00, 0x5e, 0x10, 0x44, 0x01], 0);
	frame.set([0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee], 6);
	frame[12] = 0x08;
	frame[13] = 0x00;
	frame[14] = 0x45;
	frame[16] = 0x00;
	frame[17] = 0x14;
	frame[22] = 64;
	frame[23] = 1;
	frame.set([10, 44, 205, 17], 26);
	frame.set([203, 0, 113, 7], 30);
	return Array.from(frame);
}

test('v86 route renders pairing controls and initializes mocked v86 with stable assets', async ({ page }) => {
	await installMockV86(page);
	await page.goto('/v86');

	await expect(page.getByTestId('v86-route')).toBeVisible();
	await expect(page.getByTestId('nostr-vpn-qr')).toHaveAttribute('src', /^data:image\/png;base64,/);
	await expect(page.getByText('Tailscale')).toHaveCount(0);
	await expect(page.getByTestId('v86-nvpn-state')).toContainText('Pair with Nostr VPN');

	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.options))
		.toMatchObject({
			wasm_path: '/v86/v86.wasm',
			biosUrl: '/v86/seabios.bin',
			vgaBiosUrl: '/v86/vgabios.bin',
			bzimageUrl: 'https://i.copy.sh/buildroot-bzimage68.bin',
			netDevice: {
				type: 'virtio',
				id: 0,
				mtu: 1500,
			},
			hasScreenContainer: true,
			hasSerialContainer: true,
		});
	await expect.poll(
		() => page.evaluate(() => Object.keys(window.__v86RouteTestState.listeners).sort()),
	).toEqual(expect.arrayContaining(['emulator-ready', 'emulator-started']));
});

test('paired v86 route passes a packet backend into the FIPS transport start path', async ({ page }) => {
	await installMockV86(page, { paired: true });
	await page.goto('/v86');

	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.fipsCalls.length))
		.toBeGreaterThan(0);
	await expect(page.getByTestId('v86-nvpn-state')).toContainText('Nostr VPN packet bridge ready');

	const fipsCall = await page.evaluate(() => window.__v86RouteTestState.fipsCalls[0]);
	expect(fipsCall).toMatchObject({
		hasPacketBackend: true,
		mtu: 1280,
		backendStatus: {
			guestIp: '10.44.102.102',
			gatewayIp: '10.44.0.1',
			guestMac: '',
		},
	});

	const packetFlow = await page.evaluate((frameBytes) => {
		const listener = window.__v86RouteTestState.listeners['net0-send']?.[0];
		listener?.(new Uint8Array(frameBytes));
		return {
			hasNetListener: Boolean(listener),
			txPackets: window.__v86RouteTestState.txPackets,
		};
	}, ipv4EthernetFrame());
	expect(packetFlow.hasNetListener).toBe(true);
	expect(packetFlow.txPackets).toHaveLength(1);
	expect(packetFlow.txPackets[0].slice(0, 4)).toEqual([0x45, 0x00, 0x00, 0x14]);
});

test('paired v86 route waits for explicit mesh context before creating packet networking', async ({ page }) => {
	await installMockV86(page, { paired: true, includeMeshContext: false });
	await page.goto('/v86');

	await expect(page.getByTestId('v86-nvpn-state')).toContainText('Waiting for native mesh context');
	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.fipsCalls.length))
		.toBe(0);
});

test('paired v86 route exposes missing native mesh context without fallback networking', async ({ page }) => {
	await installMockV86(page, { paired: true, fipsMode: 'missing-context' });
	await page.goto('/v86');

	await expect(page.getByTestId('v86-nvpn-state')).toContainText('Waiting for native mesh context');
	await expect(page.getByTestId('v86-backend-status')).toContainText(
		'packet bridge requires native mesh context',
	);
	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.fipsCalls[0]))
		.toMatchObject({
			hasPacketBackend: true,
			mtu: 1280,
		});
});
