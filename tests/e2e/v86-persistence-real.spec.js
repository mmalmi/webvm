import { expect, test } from '@playwright/test';

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
	const terminal = page.getByTestId('v86-serial');
	await terminal.click();
	await page.keyboard.insertText(`${command}; printf '${marker}\\n'`);
	await page.keyboard.press('Enter');
	await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain(marker);
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

async function invalidateSavedDiskCompatibility(page) {
	await page.evaluate(async () => {
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
		delete record.portableFiles?.['/var/lib/nvpn/config.toml'];
		delete record.portableFiles?.['/var/lib/nvpn/.config.toml.nostr-secret-key.secret'];
		delete record.portableFiles?.['/var/lib/nvpn/.config.toml.pending-join-request.secret'];
		delete record.portableFiles?.[
			'/var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret'
		];
		delete record.portableFiles?.[
			'/var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret'
		];
		store.put(record, 'root-filesystem');
		await new Promise((resolve, reject) => {
			transaction.oncomplete = resolve;
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		database.close();
	});
}

test('real v86 preserves ordinary nVPN state across a guest upgrade', async ({ page }) => {
	await page.goto('/v86');
	await expect(page.getByTestId('v86-serial').locator('.xterm-rows'))
		.toContainText('Starting FIPS networking...');
	await waitForTerminal(page);
	await expect(page.getByLabel('WebVM controls')).toContainText('Local disk');

	const terminal = page.getByTestId('v86-serial');
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
		"printf 'browser-local-data\\n' > /root/webvm-persistence-check",
		'__FILE_WRITTEN__',
	);
	await runCommand(
		page,
		"mkdir -p /var/lib/nvpn && printf 'network_id = \"upgrade-fixture\"\\n' > /var/lib/nvpn/config.toml && printf 'nostr-secret-fixture\\n' > /var/lib/nvpn/.config.toml.nostr-secret-key.secret && printf 'pending-request-fixture\\n' > /var/lib/nvpn/.config.toml.pending-join-request.secret && printf 'wg-preshared-fixture\\n' > /var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret && printf 'wg-private-fixture\\n' > /var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret",
		'__NVPN_STATE_WRITTEN__',
	);
	await runCommand(page, 'echo user-history-survives-refresh', '__USER_HISTORY_WRITTEN__');
	await runCommand(page, 'history -w', '__USER_HISTORY_FLUSHED__');
	await page.evaluate(() => globalThis.irisWebvmV86.flushDisk());
	await expect.poll(() => savedDiskExists(page), { timeout: 15_000 }).toBe(true);

	await page.reload();
	await waitForTerminal(page);
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
		'test ! -e /root/webvm-persistence-check && echo upgrade-clean',
		'__UPGRADE_CHECKED__',
	);
	await expect.poll(() => terminalText(page)).toContain('upgrade-clean');
	await runCommand(
		page,
		"grep -F 'network_id = \"upgrade-fixture\"' /var/lib/nvpn/config.toml && grep -F 'nostr-secret-fixture' /var/lib/nvpn/.config.toml.nostr-secret-key.secret && grep -F 'pending-request-fixture' /var/lib/nvpn/.config.toml.pending-join-request.secret && grep -F 'wg-preshared-fixture' /var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret && grep -F 'wg-private-fixture' /var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret",
		'__NVPN_STATE_UPGRADED__',
	);
	const upgradedNvpnState = await terminalText(page);
	expect(upgradedNvpnState).toContain('network_id = "upgrade-fixture"');

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
	await runCommand(
		page,
		'test ! -e /var/lib/nvpn/config.toml && test ! -e /var/lib/nvpn/.config.toml.nostr-secret-key.secret && test ! -e /var/lib/nvpn/.config.toml.pending-join-request.secret && test ! -e /var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret && test ! -e /var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret && echo nvpn-reset-clean',
		'__NVPN_RESET_CHECKED__',
	);
	await expect.poll(() => terminalText(page)).toContain('nvpn-reset-clean');
});
