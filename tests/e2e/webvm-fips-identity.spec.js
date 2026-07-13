import { webcrypto } from 'node:crypto';

import { expect, test } from '@playwright/test';

import {
	clearWebvmFipsIdentity,
	loadOrCreateWebvmFipsIdentity,
} from '../../src/lib/webvmFipsIdentity.js';

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
