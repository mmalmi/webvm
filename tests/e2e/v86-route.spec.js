import { expect, test } from '@playwright/test';

import { createV86EthernetFramePort } from '../../src/lib/v86EthernetFramePort.js';

function installMockV86(page) {
	return page.addInitScript(() => {
		window.__v86RouteTestState = {
			busSends: [],
			destroyed: false,
			hostCalls: [],
			hostStopped: false,
			listeners: {},
			options: null,
		};
		window.irisWebvmV86TestHooks = {
			createV86(options) {
				window.__v86RouteTestState.options = {
					wasm_path: options.wasm_path,
					memory_size: options.memory_size,
					biosUrl: options.bios?.url,
					vgaBiosUrl: options.vga_bios?.url,
					bzimage: options.bzimage,
					bzimageInitrdFromFilesystem: options.bzimage_initrd_from_filesystem,
					cmdline: options.cmdline,
					filesystem: options.filesystem,
					netDevice: options.net_device,
					hasScreenContainer: Boolean(options.screen?.container),
					hasSerialContainer: Boolean(options.serial_container),
				};
				const emulator = {
					add_listener(event, listener) {
						window.__v86RouteTestState.listeners[event] ||= [];
						window.__v86RouteTestState.listeners[event].push(listener);
						if (event === 'emulator-ready' || event === 'emulator-started') {
							setTimeout(() => listener(), 0);
						}
					},
					remove_listener(event, listener) {
						window.__v86RouteTestState.listeners[event] = (
							window.__v86RouteTestState.listeners[event] || []
						).filter((candidate) => candidate !== listener);
					},
					bus: {
						send(event, frame) {
							window.__v86RouteTestState.busSends.push({
								event,
								frame: Array.from(frame || []),
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
			createFipsHost({ emulator, onStatus }) {
				window.__v86RouteTestState.hostCalls.push({
					sameEmulator: emulator === window.__v86RouteTestState.emulator,
				});
				onStatus({
					state: 'ready',
					error: '',
					publicKeyHex: '02' + 'a'.repeat(64),
					nodeAddrHex: 'b'.repeat(32),
					ethernetPeers: 1,
					webrtcPeers: 2,
				});
				return {
					stop() {
						window.__v86RouteTestState.hostStopped = true;
					},
				};
			},
		};
	});
}

test('v86 boots only same-origin guest assets and starts the generic FIPS host', async ({ page }) => {
	await installMockV86(page);
	await page.goto('/v86');

	await expect(page.getByTestId('v86-route')).toBeVisible();
	await expect(page.getByTestId('v86-fips-state')).toContainText('FIPS connected');
	await expect(page.getByText('Pairing', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Tailscale')).toHaveCount(0);

	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.options))
		.toMatchObject({
			wasm_path: '/v86/v86.wasm',
			memory_size: 256 * 1024 * 1024,
			biosUrl: '/v86/seabios.bin',
			vgaBiosUrl: '/v86/vgabios.bin',
			bzimageInitrdFromFilesystem: true,
			filesystem: {
				baseurl: '/v86/guest/rootfs/',
				basefs: '/v86/guest/fs.json',
			},
			netDevice: {
				type: 'virtio',
				id: 0,
				mtu: 1500,
			},
			hasScreenContainer: true,
			hasSerialContainer: true,
		});
	const state = await page.evaluate(() => window.__v86RouteTestState);
	expect(state.options.bzimage).toBeUndefined();
	expect(state.options.cmdline).toContain('root=host9p');
	expect(state.hostCalls).toEqual([{ sameEmulator: true }]);
});

test('v86 frame port carries complete Ethernet frames in both directions', () => {
	const listeners = new Map();
	const injected = [];
	const emulator = {
		add_listener(event, listener) {
			listeners.set(event, listener);
		},
		remove_listener(event, listener) {
			if (listeners.get(event) === listener) listeners.delete(event);
		},
		bus: {
			send(event, frame) {
				injected.push({ event, frame });
			},
		},
	};
	const port = createV86EthernetFramePort(emulator);
	const received = [];
	const stop = port.onFrame((frame) => received.push(frame));
	const frame = new Uint8Array([
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
		0x21, 0x21, 0x01, 0x01,
	]);

	listeners.get('net0-send')(frame);
	port.sendFrame(frame);
	frame.fill(0);
	stop();

	expect(Array.from(received[0])).toEqual([
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
		0x21, 0x21, 0x01, 0x01,
	]);
	expect(injected[0].event).toBe('net0-receive');
	expect(Array.from(injected[0].frame)).toEqual([
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
		0x21, 0x21, 0x01, 0x01,
	]);
	expect(listeners.has('net0-send')).toBe(false);
});
