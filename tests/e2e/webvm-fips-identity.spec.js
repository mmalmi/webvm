import { webcrypto } from 'node:crypto';

import { expect, test } from '@playwright/test';

import {
	clearWebvmFipsIdentity,
	loadOrCreateWebvmFipsIdentity,
} from '../../src/lib/webvmFipsIdentity.js';
import {
	clearPreferredWebvmFipsIngresses,
	loadPreferredWebvmFipsIngresses,
	rememberWebvmFipsIngress,
} from '../../src/lib/webvmFipsIngress.js';
import { decodeMeshIngressHint } from '../../src/lib/webvmNostrPubsubService.js';

class MemoryStorage {
	values = new Map();
	writes = 0;

	getItem(key) {
		return this.values.get(key) ?? null;
	}

	setItem(key, value) {
		this.writes += 1;
		this.values.set(key, value);
	}

	removeItem(key) {
		this.values.delete(key);
	}
}

test('WebVM keeps its browser FIPS identity across reloads and clears it on reset', async () => {
	const storage = new MemoryStorage();
	const first = await loadOrCreateWebvmFipsIdentity({ storage, crypto: webcrypto });
	const restored = await loadOrCreateWebvmFipsIdentity({ storage, crypto: webcrypto });

	expect([...restored.publicKey]).toEqual([...first.publicKey]);
	expect(storage.writes).toBe(1);

	clearWebvmFipsIdentity(storage);
	const reset = await loadOrCreateWebvmFipsIdentity({ storage, crypto: webcrypto });
	expect([...reset.publicKey]).not.toEqual([...first.publicKey]);
});

test('WebVM refuses to silently replace a damaged persisted FIPS identity', async () => {
	const storage = new MemoryStorage();
	storage.values.set('iris-webvm:fips-host-identity:v1', 'not-a-secret-key');

	await expect(loadOrCreateWebvmFipsIdentity({ storage, crypto: webcrypto }))
		.rejects.toThrow('invalid persisted WebVM FIPS identity');
});

test('WebVM reconnects its most recently successful FIPS ingresses first', () => {
	const storage = new MemoryStorage();
	const peers = Array.from({ length: 6 }, (_, index) =>
		`02${(index + 1).toString(16).padStart(64, '0')}`);
	for (const peer of peers) rememberWebvmFipsIngress(peer, storage);
	rememberWebvmFipsIngress(peers[3], storage);

	expect(loadPreferredWebvmFipsIngresses(storage)).toEqual([
		peers[3],
		peers[5],
		peers[4],
		peers[2],
	]);
	clearPreferredWebvmFipsIngresses(storage);
	expect(loadPreferredWebvmFipsIngresses(storage)).toEqual([]);
});

test('WebVM ignores the ingress cache populated by arbitrary v1 connections', () => {
	const storage = new MemoryStorage();
	const arbitraryPeer = `02${'7'.repeat(64)}`;
	storage.values.set('iris-webvm:fips-ingress-peers:v1', JSON.stringify([arbitraryPeer]));

	expect(loadPreferredWebvmFipsIngresses(storage)).toEqual([]);
});

test('WebVM decodes the rostered mesh ingress announced by its local guest', () => {
	const hintedPeer = new Uint8Array(32).fill(0x5a);
	const payload = new Uint8Array(9 + hintedPeer.length);
	payload.set(new TextEncoder().encode('NVPNMESH1'));
	payload.set(hintedPeer, 9);

	expect(decodeMeshIngressHint(payload)).toBe('5a'.repeat(32));
});
