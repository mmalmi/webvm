import { expect, test } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';

const FACT_OP_KIND = 7368;
const RECEIPT_TYPE = 'nostr_identity_device_approval_receipt';

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function buildApprovalReceiptEvent(identity) {
	const signerSecretKey = generateSecretKey();
	const approvedByPubkey = getPublicKey(signerSecretKey);
	const approvedAt = Math.floor(Date.now() / 1000);
	const receipt = {
		schema: 1,
		profileId: '550e8400-e29b-41d4-a716-446655440000',
		requestPubkey: identity.requestPubkeyHex,
		deviceAppKeyPubkey: identity.appPubkeyHex,
		approvedByPubkey,
		approvedAt,
		requestSecret: identity.requestSecret,
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

test('Nostr VPN join QR detects native acceptance with the request secret', async ({ page }) => {
	await page.goto('/');
	await page.getByTestId('sidebar-nostr-vpn').click();

	await expect(page.getByTestId('nostr-vpn-qr')).toHaveAttribute(
		'src',
		/^data:image\/png;base64,/,
	);
	const joinRequest = page.getByTestId('nostr-vpn-join-request');
	await expect(joinRequest).toContainText('nvpn://join-request/');
	await expect(page.getByText('Tailscale')).toHaveCount(0);

	const identity = await page.evaluate(() => {
		const raw = localStorage.getItem('iris-webvm.nostr-vpn.identity.v2');
		return JSON.parse(raw);
	});
	const receiptEvent = buildApprovalReceiptEvent(identity);
	const accepted = await page.evaluate((event) => {
		window.dispatchEvent(new CustomEvent('nvpn:approval-receipt', { detail: { event } }));
		const identity = JSON.parse(localStorage.getItem('iris-webvm.nostr-vpn.identity.v2'));
		return {
			requestSecretLength: identity.requestSecret.length,
			link: window.irisWebvmNostrVpn.joinRequestLink(),
			paired: identity.paired,
		};
	}, receiptEvent);

	expect(accepted.requestSecretLength).toBeGreaterThanOrEqual(32);
	expect(accepted.link).toContain('nvpn://join-request/');
	expect(accepted.paired.profileId).toBe('550e8400-e29b-41d4-a716-446655440000');
	await expect(page.getByTestId('nostr-vpn-pairing-status')).toHaveText('Paired');
	await expect(page.getByText('Native app accepted')).toBeVisible();
	await expect(page.getByText('550e8400-e29b-41d4-a716-446655440000')).toBeVisible();
});
