import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { WEBVM_GUEST_TOOLS } from '../../src/lib/webvmGuestTools.js';
import { parseSerialCommandResult } from './helpers/webvm-serial-command.js';

const NVPN_SECRET_PATHS = [
	'/var/lib/nvpn/.config.toml.nostr-secret-key.secret',
	'/var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret',
	'/var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret',
];
const NVPN_SECRET_HASH_COMMAND = `sha256sum ${NVPN_SECRET_PATHS.join(' ')}`;
const USER_FILE_CHECK = "test \"$(stat -c '%a:%u:%g' /home/saved/nested/private)\" = 600:123:456 && " +
	"test \"$(readlink /root/saved-link)\" = /home/saved/nested/private && " +
	"test \"$(stat -c %i /root/saved-hardlink)\" = \"$(stat -c %i /home/saved/nested/private)\" && " +
	"grep -qx 'retained private file' /root/saved-link && " +
	"grep -qx 'browser-local-data' /root/webvm-persistence-check";
const HASHTREE_IDENTITY_CHECK = 'find /var/lib/hashtree/config/keys -type f ' +
	'-exec sha256sum {} \\; -exec stat -c "%a:%u:%g" {} \\;';

async function waitForTerminal(page) {
	await page.waitForFunction(
		() => globalThis.irisWebvmV86?.state?.().terminalReady === true,
		null,
		{ timeout: 60_000 },
	);
}

async function terminalText(page) {
	return page.evaluate(() => {
		const buffer = globalThis.irisWebvmV86.serialTerminal.buffer.active;
		const lines = [];
		for (let index = 0; index < buffer.length; index += 1) {
			lines.push(buffer.getLine(index)?.translateToString(true) || '');
		}
		return lines.join('\n');
	});
}

async function runCommand(page, command, marker) {
	const token = randomUUID().replaceAll('-', '');
	const begin = `__WEBVM_PERSISTENCE_BEGIN_${token}__`;
	const end = `__WEBVM_PERSISTENCE_END_${token}__`;
	const terminal = page.getByTestId('v86-serial');
	await terminal.click();
	await page.keyboard.insertText(
		`printf '${begin}\\n'; ${command}; rc=$?; ` +
			`printf '${marker}\\n${end}:%s\\n' "$rc"`,
	);
	await page.keyboard.press('Enter');
	// Commands may intentionally contain a 30-second guest-side readiness loop;
	// leave enough host-side margin for v86 scheduling and terminal rendering.
	await expect.poll(
		async () => Boolean(parseSerialCommandResult(await terminalText(page), begin, end)),
		{ timeout: 60_000 },
	).toBe(true);
	const result = parseSerialCommandResult(await terminalText(page), begin, end);
	expect(result?.status).toBe(0);
	return result.output.filter((line) => line !== marker);
}

async function savedDiskExists(page) {
	return page.evaluate(async () => {
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
		return Boolean(record);
	});
}

async function invalidateSavedDiskCompatibility(page, breakReceipt = false) {
	return page.evaluate(async ({ breakReceipt, toolPaths }) => {
		globalThis.irisWebvmV86.emulator.stop();
		await globalThis.irisWebvmV86.flushDisk();
		const database = await new Promise((resolve, reject) => {
			const request = indexedDB.open('iris-webvm', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const transaction = database.transaction('disks', 'readwrite');
		const store = transaction.objectStore('disks');
		const record = await new Promise((resolve, reject) => {
			const request = store.get('root-filesystem');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		record.compatibilityId = 'previous-guest-release';
		delete record.portableFiles;
		// Saved executable caches must not shadow any newly shipped tool.
		for (const toolPath of toolPaths) {
			const { id } = globalThis.irisWebvmV86.emulator.fs9p.SearchPath(toolPath);
			record.state[2] = record.state[2].filter(([inodeId]) => inodeId !== id);
			record.state[2].push([id, new Uint8Array([0])]);
			record.state[0][id][3] = 0;
			record.state[0][id][4] = 1;
		}
		if (breakReceipt) {
			const receipt = globalThis.irisWebvmV86.emulator.fs9p.SearchPath('/etc/webvm-guest-binaries.sha256');
			record.state[0][receipt.id][0] = 0o120777;
			record.state[0][receipt.id][1] = '/root/saved-user-file';
		}
		store.put(record, 'root-filesystem');
		await new Promise((resolve, reject) => {
			transaction.oncomplete = resolve;
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		database.close();
		return Array.from(new Uint8Array(await crypto.subtle.digest(
			'SHA-256', new TextEncoder().encode(JSON.stringify(record)),
		)));
	}, { breakReceipt, toolPaths: Object.values(WEBVM_GUEST_TOOLS) });
}

async function savedDiskFingerprint(page) {
	return page.evaluate(async () => {
		const database = await new Promise((resolve, reject) => {
			const request = indexedDB.open('iris-webvm', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const record = await new Promise((resolve, reject) => {
			const request = database.transaction('disks').objectStore('disks').get('root-filesystem');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		database.close();
		return Array.from(new Uint8Array(await crypto.subtle.digest(
			'SHA-256', new TextEncoder().encode(JSON.stringify(record)),
		)));
	});
}

test('real v86 reopens offline with saved files and service identities', async ({ page, context }, testInfo) => {
	test.setTimeout(150_000);
	await page.goto('/v86');
	await waitForTerminal(page);
	await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
	await runCommand(page,
		"printf 'offline workspace\\n' > /root/offline-file && chmod 600 /root/offline-file && " +
			'curl --version >/dev/null', '__OFFLINE_FILE_SAVED__');
	const hashtree = await runCommand(page, HASHTREE_IDENTITY_CHECK, '__OFFLINE_HASHTREE_IDENTITY__');
	expect(hashtree.length).toBeGreaterThan(0);
	const nvpn = await runCommand(page,
		'for i in $(seq 1 30); do test -s /var/lib/nvpn/.config.toml.nostr-secret-key.secret && break; sleep 1; done; ' +
			'sha256sum /var/lib/nvpn/.config.toml.nostr-secret-key.secret', '__OFFLINE_NVPN_IDENTITY__');
	const identity = await page.evaluate(() => localStorage.getItem('iris-webvm:fips-host-identity:v1'));
	expect(identity).toMatch(/^[0-9a-f]{64}$/u);
	const cachesBefore = await page.evaluate(async () => {
		const cache = await caches.open('iris-webvm:rootfs-v1');
		return (await cache.keys()).map((request) => new URL(request.url).pathname);
	});
	expect(cachesBefore.length).toBeGreaterThan(0);
	// Lazy reads must not turn into a download of the complete 1,000+ file guest.
	expect(cachesBefore.length).toBeLessThan(200);
	await page.evaluate(async () => {
		globalThis.irisWebvmV86.emulator.stop();
		await globalThis.irisWebvmV86.flushDisk();
	});
	await context.setOffline(true);
	await page.reload();
	await waitForTerminal(page);
	await runCommand(page,
		"test \"$(stat -c %a /root/offline-file)\" = 600 && grep -qx 'offline workspace' /root/offline-file && " +
			'curl --version >/dev/null', '__OFFLINE_FILE_RESTORED__');
	expect(await runCommand(page, HASHTREE_IDENTITY_CHECK, '__OFFLINE_HASHTREE_RESTORED__')).toEqual(hashtree);
	expect(await runCommand(page, 'sha256sum /var/lib/nvpn/.config.toml.nostr-secret-key.secret',
		'__OFFLINE_NVPN_RESTORED__')).toEqual(nvpn);
	expect(await page.evaluate(() => localStorage.getItem('iris-webvm:fips-host-identity:v1'))).toBe(identity);
	await runCommand(page, "printf 'written offline\\n' >> /root/offline-file", '__OFFLINE_EDIT_SAVED__');
	await page.evaluate(async () => {
		globalThis.irisWebvmV86.emulator.stop();
		await globalThis.irisWebvmV86.flushDisk();
	});
	await page.reload();
	await waitForTerminal(page);
	await runCommand(page, "grep -qx 'written offline' /root/offline-file", '__OFFLINE_EDIT_RESTORED__');
	await page.screenshot({ path: testInfo.outputPath('offline-workspace.png') });
	await testInfo.attach('offline-cache', { body: JSON.stringify({ rootfsFiles: cachesBefore.length }), contentType: 'application/json' });
});

test('real v86 preserves saved files and service identities across a guest upgrade', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	await page.goto('/v86');
	await expect(page.getByTestId('v86-serial').locator('.xterm-rows'))
		.toContainText('Starting FIPS networking...');
	await waitForTerminal(page);
	await expect(page.getByLabel('WebVM controls')).toContainText('Local disk');
	await runCommand(
		page,
		"grep -qx 'db_max_size_gb = 0' /var/lib/hashtree/config/config.toml && " +
			'curl --silent --show-error --max-time 5 --output /dev/null http://127.0.0.1/',
		'__HASHTREE_STARTED__',
	);

	const terminal = page.getByTestId('v86-serial');
	await runCommand(
		page,
		"for i in $(seq 1 30); do test -s /run/webvm/nvpn.pid && tr '\\0' '\\n' </proc/$(cat /run/webvm/nvpn.pid)/environ | grep -qx 'NVPN_FIPS_NOSTR_DISCOVERY_POLICY=open' && break; sleep 1; done; tr '\\0' '\\n' </proc/$(cat /run/webvm/nvpn.pid)/environ | grep -qx 'NVPN_FIPS_NOSTR_DISCOVERY_POLICY=open'",
		'__NVPN_FIPS_TRANSIT_POLICY_READY__',
	);
	await terminal.click();
	await page.keyboard.press('ArrowUp');
	await expect.poll(() => terminalText(page)).not.toContain('rc-service webvm-nvpn start');
	await page.keyboard.press('Control+C');

	await runCommand(page, 'history', '__HISTORY_CHECKED__');
	const history = await terminalText(page);
	expect(history).not.toContain('webvm-snapshot-scrub');
	expect(history).not.toContain('rc-service webvm-nvpn start');

	await runCommand(
		page,
		"printf 'browser-local-data\\n' > /root/webvm-persistence-check && " +
			"mkdir -p /home/saved/nested && printf 'retained private file\\n' > /home/saved/nested/private && " +
			'chmod 600 /home/saved/nested/private && chown 123:456 /home/saved/nested/private && ' +
			'ln -s /home/saved/nested/private /root/saved-link && ' +
			'ln /home/saved/nested/private /root/saved-hardlink',
		'__FILE_WRITTEN__',
	);
	const expectedHashtreeIdentity = await runCommand(page, HASHTREE_IDENTITY_CHECK, '__HASHTREE_IDENTITY__');
	expect(expectedHashtreeIdentity.length).toBeGreaterThan(0);
	const manifest = await (await page.request.get('/v86/guest/manifest.json')).json();
	await runCommand(
		page,
		"nvpn set --config /var/lib/nvpn/config.toml --node-name upgrade-fixture " +
			"--wireguard-exit-enabled false " +
			"--wireguard-exit-private-key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= " +
			"--wireguard-exit-peer-preshared-key AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
		'__NVPN_STATE_WRITTEN__',
	);
	await runCommand(
		page,
		'nvpn join-request --config /var/lib/nvpn/config.toml --no-wait --no-qr >/dev/null',
		'__NVPN_REQUEST_WRITTEN__',
	);
	const expectedSecretHashes = await runCommand(
		page,
		NVPN_SECRET_HASH_COMMAND,
		'__NVPN_SECRETS_HASHED__',
	);
	await runCommand(page, 'echo user-history-survives-refresh', '__USER_HISTORY_WRITTEN__');
	await runCommand(
		page,
		"sed -i 's/^db_max_size_gb = 0$/db_max_size_gb = 1/' /var/lib/hashtree/config/config.toml",
		'__OLD_HASHTREE_LIMIT_SAVED__',
	);
	await runCommand(page, 'history -w', '__USER_HISTORY_FLUSHED__');
	await page.evaluate(() => globalThis.irisWebvmV86.flushDisk());
	await expect.poll(() => savedDiskExists(page), { timeout: 15_000 }).toBe(true);

	await page.reload();
	await waitForTerminal(page);
	await runCommand(
		page,
		"grep -qx 'db_max_size_gb = 0' /var/lib/hashtree/config/config.toml && " +
			'curl --silent --show-error --max-time 5 --output /dev/null http://127.0.0.1/',
		'__HASHTREE_RESTORED__',
	);
	await runCommand(page, 'cat /root/webvm-persistence-check', '__FILE_RESTORED__');
	await expect.poll(() => terminalText(page)).toContain('browser-local-data');
	await runCommand(page, 'history', '__HISTORY_RESTORED__');
	const restoredHistory = await terminalText(page);
	expect(restoredHistory).toContain('echo user-history-survives-refresh');
	expect(restoredHistory).not.toContain('rc-service webvm-nvpn start');
	await page.evaluate(() => globalThis.irisWebvmV86.flushDisk());
	await invalidateSavedDiskCompatibility(page);

	await page.reload();
	await waitForTerminal(page);
	await runCommand(page, 'history', '__HISTORY_UPGRADED__');
	const upgradedHistory = await terminalText(page);
	expect(upgradedHistory).toContain('echo user-history-survives-refresh');
	await runCommand(
		page,
		`${USER_FILE_CHECK} && echo upgrade-preserved`,
		'__UPGRADE_CHECKED__',
	);
	await expect.poll(() => terminalText(page)).toContain('upgrade-preserved');
	expect(await runCommand(page, HASHTREE_IDENTITY_CHECK, '__HASHTREE_IDENTITY_UPGRADED__'))
		.toEqual(expectedHashtreeIdentity);
	const binaryHashes = await runCommand(page,
		`sha256sum ${Object.values(WEBVM_GUEST_TOOLS).join(' ')}`, '__GUEST_TOOLS_UPGRADED__');
	expect(binaryHashes).toEqual(Object.entries(WEBVM_GUEST_TOOLS)
		.map(([name, filePath]) => `${manifest.binaries[name].sha256}  ${filePath}`));
	const upgradedNvpnState = await runCommand(
		page,
		"grep -F 'node_name = \"upgrade-fixture\"' /var/lib/nvpn/config.toml",
		'__NVPN_STATE_UPGRADED__',
	);
	expect(upgradedNvpnState.join('\n')).toContain('node_name = "upgrade-fixture"');
	const upgradedSecretHashes = await runCommand(
		page,
		NVPN_SECRET_HASH_COMMAND,
		'__NVPN_SECRETS_UPGRADED__',
	);
	expect(upgradedSecretHashes).toEqual(expectedSecretHashes);

	page.once('dialog', (dialog) => dialog.accept());
	await Promise.all([
		page.waitForEvent('load'),
		page.getByTestId('v86-reset').click(),
	]);
	await waitForTerminal(page);
	await runCommand(
		page,
		'test ! -e /root/webvm-persistence-check && echo reset-clean',
		'__RESET_CHECKED__',
	);
	await expect.poll(() => terminalText(page)).toContain('reset-clean');
	const resetNvpnState = await runCommand(
		page,
		"for i in $(seq 1 30); do test -s /var/lib/nvpn/config.toml && " +
			"test -s /var/lib/nvpn/.config.toml.nostr-secret-key.secret && break; sleep 1; done; " +
			"! grep -Fq 'node_name = \"upgrade-fixture\"' /var/lib/nvpn/config.toml && " +
			"test ! -e /var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret && " +
			"test ! -e /var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret && " +
			'sha256sum /var/lib/nvpn/.config.toml.nostr-secret-key.secret',
		'__NVPN_RESET_CHECKED__',
	);
	expect(resetNvpnState[0]).not.toEqual(expectedSecretHashes[0]);

	// Fail on the checksum receipt, after the in-memory tools were patched.
	// No partial upgrade may replace the persistent record, and Reset still works.
	const savedDiskBeforeFailure = await invalidateSavedDiskCompatibility(page, true);
	await page.reload();
	await expect.poll(() => page.evaluate(() => globalThis.irisWebvmV86?.state().vmState))
		.toBe('load-failed');
	await expect.poll(() => terminalText(page)).toContain('It has not been changed.');
	expect(await savedDiskFingerprint(page)).toEqual(savedDiskBeforeFailure);
	await page.screenshot({ path: testInfo.outputPath('disk-restore-failed.png') });
	page.once('dialog', (dialog) => dialog.accept());
	await Promise.all([page.waitForEvent('load'), page.getByTestId('v86-reset').click()]);
	await waitForTerminal(page);
	await expect(page.getByLabel('WebVM controls')).toContainText('Local disk');
});
