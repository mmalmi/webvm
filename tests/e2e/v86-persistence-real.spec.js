import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { parseSerialCommandResult } from './helpers/webvm-serial-command.js';

const NVPN_SECRET_PATHS = [
	'/var/lib/nvpn/.config.toml.nostr-secret-key.secret',
	'/var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret',
	'/var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret',
];
const NVPN_SECRET_HASH_COMMAND = `sha256sum ${NVPN_SECRET_PATHS.join(' ')}`;

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
		"printf 'browser-local-data\\n' > /root/webvm-persistence-check",
		'__FILE_WRITTEN__',
	);
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
		'test ! -e /root/webvm-persistence-check && echo upgrade-clean',
		'__UPGRADE_CHECKED__',
	);
	await expect.poll(() => terminalText(page)).toContain('upgrade-clean');
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
});
