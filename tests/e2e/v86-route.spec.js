import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

import { createV86EthernetFramePort } from '../../src/lib/v86EthernetFramePort.js';

test('legacy upstream WebVM routes and assets are not published', async ({ request }) => {
	for (const path of [
		'/alpine',
		'/alpine.html',
		'/serviceWorker.js',
		'/assets/webvm_hero.png',
		'/documents/WebAssemblyTools.pdf',
	]) {
		const response = await request.get(path);
		expect(response.status(), path).toBe(404);
	}
});

test('v86 publishes the guest identity used for local disk compatibility', async ({ request }) => {
	const response = await request.get('/v86/guest/manifest.json');
	expect(response.status()).toBe(200);
	const manifest = await response.json();
	expect(manifest.schema).toBe('iris-webvm-v86-guest/v1');
	expect(manifest.artifacts.rootfs.sha256).toMatch(/^[0-9a-f]{64}$/);
});

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
			filesystemStates: [],
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
				const filesystem = {
					state: ['base'],
					get_state() {
						return this.state;
					},
					set_state(state) {
						this.state = state;
						window.__v86RouteTestState.filesystemStates.push(state);
					},
					NotifyListeners() {},
				};
				const emulator = {
					fs9p: filesystem,
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
				if (new URLSearchParams(window.location.search).has('stalled-fips')) {
					return new Promise(() => {});
				}
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

test('v86 boots the guest without waiting indefinitely for FIPS startup', async ({ page }) => {
	await installMockV86(page);
	await page.goto('/v86?cold-boot&stalled-fips');

	await expect.poll(() => page.evaluate(() => window.__v86RouteTestState.ran)).toBe(true);
	expect(await page.evaluate(() => window.__v86RouteTestState.hostCalls))
		.toEqual([{ sameEmulator: true }]);
});

test('v86 boots only same-origin guest assets and starts the generic FIPS host', async ({ page }) => {
	await installMockV86(page);
	await page.goto('/v86?cold-boot');

	await expect(page.locator('meta[http-equiv="content-security-policy"]'))
		.toHaveAttribute('content', /connect-src[^;]*\bstun:/u);
	await expect(page.locator('meta[http-equiv="content-security-policy"]'))
		.toHaveAttribute('content', /connect-src[^;]*\bwss:/u);
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
	await expect(terminal.locator('.xterm-rows')).toContainText('Download Nostr VPN (nostrvpn.org)');
	await expect(terminal.locator('.xterm-rows')).toContainText('Nostr VPN join request:  nvpn join-request');
	await expect(terminal.locator('.xterm-rows')).toContainText('FIPS and peer status:    nvpn status');
	await expect(page.locator('header')).toBeHidden();
	await expect(page.getByTestId('v86-screen')).not.toBeInViewport();
	await expect(terminal.locator('.xterm-rows')).toContainText('Starting FIPS networking...');
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
		() => window.__v86RouteTestState.serialSends.some((text) => text.includes('webvm-nvpn start')),
	)).toBe(true);
	const resumeCommand = await page.evaluate(() => window.__v86RouteTestState.serialSends.find(
		(text) => text.includes('webvm-nvpn start'),
	));
	expect(resumeCommand).toContain("hostname webvm; export PS1='root@webvm:\\w# '");
	expect(resumeCommand).toContain("sh -c '(rc-service webvm-nvpn start) >/dev/null 2>&1 &'");
	expect(resumeCommand).not.toContain('/etc/resolv.conf');
	expect(resumeCommand).toContain("sh -c '(rc-service webvm-hashtree start) >/dev/null 2>&1 &'");
	expect(resumeCommand).toContain(
		"grep -v '__IRIS_WEBVM_' /root/.ash_history 2>/dev/null || true; } > /root/.ash_history.iris-resume;",
	);
	expect(resumeCommand).toContain(
		'history -c 2>/dev/null; mv /root/.ash_history.iris-resume /root/.ash_history;',
	);
	expect(resumeCommand).not.toContain('rm -f /root/.ash_history');
	expect(resumeCommand).toContain(
		`exec /bin/ash -c "printf '\\n__IRIS_WEBVM_%s__\\n' RESUMED; exec /bin/ash"`,
	);
	expect(resumeCommand).toMatch(
		/^stty -echo; printf '%s' '[0-9a-f]{128}' \| xxd -r -p \| webvm-seed-rng; /,
	);
	expect(resumeCommand).toMatch(/date -u -s '@[0-9]{10}' >\/dev\/null; /);
	expect(resumeCommand.indexOf('webvm-seed-rng')).toBeLessThan(
		resumeCommand.indexOf('date -u -s'),
	);
	expect(resumeCommand.indexOf('date -u -s')).toBeLessThan(
		resumeCommand.indexOf('rc-service webvm-nvpn start'),
	);
	expect(resumeCommand.indexOf('rc-service webvm-nvpn start')).toBeLessThan(
		resumeCommand.indexOf('rc-service webvm-hashtree start'),
	);
	expect(resumeCommand.indexOf('rc-service webvm-hashtree start')).toBeLessThan(
		resumeCommand.indexOf('history -c'),
	);
	await expect(terminal.locator('.xterm-rows')).not.toContainText('Linux version');

	await page.evaluate(() => {
		for (const character of '\r\n__IRIS_WEBVM_RESUMED__\r\nroot@webvm:~# ') {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	await expect(terminal.locator('.xterm-rows')).toContainText('root@webvm:~#');
	await expect(terminal.locator('.xterm-rows')).not.toContainText('Starting FIPS networking...');
	await expect(terminal.locator('.xterm-rows')).not.toContainText('Linux version');
});

test('v86 accepts input only after the resumed shell is ready', async ({ page }) => {
	await installMockV86(page);
	await page.goto('/v86?cold-boot');

	const command = 'printf early-input-works';
	await page.getByTestId('v86-serial').click();
	await page.keyboard.type(command);
	await page.keyboard.press('Enter');
	expect(await page.evaluate(
		(commandText) => window.__v86RouteTestState.serialSends.join('').includes(`${commandText}\r`),
		command,
	)).toBe(false);

	await page.evaluate(() => {
		for (const character of '\r\n__IRIS_WEBVM_RESUMED__\r\nroot@webvm:~# ') {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	await page.getByTestId('v86-serial').click();
	await page.keyboard.type(command);
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(
		(commandText) => window.__v86RouteTestState.serialSends.join('').includes(`${commandText}\r`),
		command,
	)).toBe(true);
});

test('v86 persists its local disk and can reset it', async ({ page }) => {
	await installMockV86(page);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'storage', {
			configurable: true,
			value: {
				estimate: async () => ({ usageDetails: { indexedDB: 2_048 } }),
				persist: async () => true,
			},
		});
	});
	await page.goto('/v86?cold-boot');
	await expect(page.getByLabel('WebVM controls')).toContainText('Local disk · 2.0 KB');

	await page.evaluate(() => {
		const filesystem = window.__v86RouteTestState.emulator.fs9p;
		filesystem.state = ['saved-file'];
		filesystem.NotifyListeners(1, 'write');
	});
	await expect.poll(async () => page.evaluate(async () => {
		const database = await new Promise((resolve, reject) => {
			const request = indexedDB.open('iris-webvm', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const transaction = database.transaction('disks', 'readonly');
		const record = await new Promise((resolve, reject) => {
			const request = transaction.objectStore('disks').get('root-filesystem');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		database.close();
		return record?.state?.[0];
	})).toBe('saved-file');

	await page.reload();
	await expect.poll(() => page.evaluate(
		() => window.__v86RouteTestState.filesystemStates.at(-1)?.[0],
	)).toBe('saved-file');

	page.once('dialog', async (dialog) => {
		expect(dialog.message()).toBe("Delete this browser's saved WebVM disk and start clean?");
		await dialog.accept();
	});
	await Promise.all([
		page.waitForEvent('load'),
		page.getByTestId('v86-reset').click(),
	]);
	await expect(page.getByLabel('WebVM controls')).toContainText('Local disk');
	await expect.poll(() => page.evaluate(
		() => window.__v86RouteTestState.filesystemStates.length,
	)).toBe(0);
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
		() => window.__v86RouteTestState.serialSends.some((text) => text.includes('webvm-nvpn start')),
	)).toBe(true);
	await page.evaluate(() => {
		const commandEcho = window.__v86RouteTestState.serialSends.find(
			(text) => text.includes('webvm-nvpn start'),
		);
		for (const character of commandEcho) {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	expect(await page.evaluate(() => globalThis.irisWebvmV86.state().terminalReady)).toBe(false);
	await page.evaluate(() => {
		for (const character of '\r\n__IRIS_WEBVM_RESUMED__\r\nroot@webvm:~# ') {
			for (const listener of window.__v86RouteTestState.listeners['serial0-output-byte'] || []) {
				listener(character.charCodeAt(0));
			}
		}
	});
	const terminalText = page.getByTestId('v86-serial').locator('.xterm-rows');
	await expect(terminalText).toContainText('root@webvm:~#');
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
