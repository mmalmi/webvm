import { expect, test } from '@playwright/test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, SimplePool } from 'nostr-tools';

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
	} finally {
		await relay.stop();
	}
});
