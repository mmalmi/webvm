import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

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
			serialSends: [],
		};
		window.irisWebvmV86TestHooks = {
			createV86(options) {
				window.__v86RouteTestState.options = {
					autostart: options.autostart,
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
					run() {
						window.__v86RouteTestState.ran = true;
					},
					serial0_send(text) {
						window.__v86RouteTestState.serialSends.push(text);
					},
					restore_state(state) {
						window.__v86RouteTestState.restoredState = Array.from(new Uint8Array(state));
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
	await page.goto('/v86?cold-boot');

	await expect(page.getByTestId('v86-route')).toBeVisible();
	await expect(page.getByTestId('v86-fips-state')).toContainText('FIPS connected');
	await expect(page.getByText('Pairing', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Tailscale')).toHaveCount(0);

	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.options))
		.toMatchObject({
			autostart: false,
			wasm_path: '/v86/v86.wasm',
			memory_size: 96 * 1024 * 1024,
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
	expect(state.ran).toBe(true);
});

test('v86 presents one WebVM-style terminal and never reveals cold-boot output', async ({ page }) => {
	await installMockV86(page);
	await page.goto('/v86?cold-boot');

	const terminal = page.getByTestId('v86-serial');
	await expect(terminal.locator('.xterm-rows')).toContainText('A private Linux workspace');
	await expect(page.locator('header')).toBeHidden();
	await expect(page.getByTestId('v86-screen')).not.toBeInViewport();
	const bounds = await terminal.boundingBox();
	expect(bounds).toMatchObject({ x: 0, y: 0 });
	expect(bounds.width).toBe(1280);
	expect(bounds.height).toBe(720);

	await page.evaluate(() => {
		const output = [
			'Linux version 6.12.95 booting...\r\n',
			'+----------------------------------------------------------------------------+\r\n',
			'| Iris WebVM                                                                |\r\n',
			'(none):~# ',
		].join('');
		for (const character of output) {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	await expect.poll(() => page.evaluate(
		() => window.__v86RouteTestState.serialSends.some((text) => text.includes('webvm-hashtree start')),
	)).toBe(true);
	await expect(terminal.locator('.xterm-rows')).not.toContainText('Linux version');

	await page.evaluate(() => {
		for (const character of '\r\n__IRIS_WEBVM_RESUMED__\r\n(none):~# ') {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	await expect(terminal.locator('.xterm-rows')).toContainText('(none):~#');
	await expect(terminal.locator('.xterm-rows')).not.toContainText('Linux version');
});

test('v86 restores the preinitialized logged-in environment before starting guest services', async ({ page }) => {
	const state = Buffer.from([1, 3, 3, 7]);
	await page.route('**/v86/guest/state/manifest.json', (route) => route.fulfill({
		contentType: 'application/json',
		body: JSON.stringify({
			schema: 1,
			bytes: state.length,
			chunks: [{
				file: 'state-000.bin',
				bytes: state.length,
				sha256: createHash('sha256').update(state).digest('hex'),
			}],
		}),
	}));
	await page.route('**/v86/guest/state/state-000.bin', (route) => route.fulfill({ body: state }));
	await installMockV86(page);
	await page.goto('/v86');

	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.restoredState))
		.toEqual([...state]);
	await expect.poll(() => page.evaluate(
		() => window.__v86RouteTestState.serialSends.some((text) => text.includes('webvm-hashtree start')),
	)).toBe(true);
	await page.evaluate(() => {
		const commandEcho = window.__v86RouteTestState.serialSends.find(
			(text) => text.includes('webvm-hashtree start'),
		);
		for (const character of commandEcho) {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	expect(await page.evaluate(() => globalThis.irisWebvmV86.state().terminalReady)).toBe(false);
	await page.evaluate(() => {
		for (const character of '\r\n__IRIS_WEBVM_RESUMED__\r\n(none):~# ') {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	const terminalText = page.getByTestId('v86-serial').locator('.xterm-rows');
	await expect(terminalText).toContainText('(none):~#');
	await expect(terminalText).not.toContainText('__IRIS_WEBVM_RESUMED__');
	await expect(terminalText).not.toContainText('rc-service webvm-hashtree');
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
