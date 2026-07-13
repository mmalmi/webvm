import { identityFromSecretKey } from '@fips/core';

export const WEBVM_FIPS_IDENTITY_STORAGE_KEY = 'iris-webvm:fips-host-identity:v1';

function decodeSecretKey(value) {
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		throw new Error('invalid persisted WebVM FIPS identity');
	}
	return Uint8Array.from(value.match(/../gu), (byte) => Number.parseInt(byte, 16));
}

function encodeSecretKey(secretKey) {
	return [...secretKey].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireStorage(storage) {
	if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) {
		throw new Error('WebVM FIPS identity storage is unavailable');
	}
	return storage;
}

export async function loadOrCreateWebvmFipsIdentity({
	storage = globalThis.localStorage,
	crypto = globalThis.crypto,
} = {}) {
	const identityStorage = requireStorage(storage);
	const persisted = identityStorage.getItem(WEBVM_FIPS_IDENTITY_STORAGE_KEY);
	if (persisted !== null) {
		try {
			const identity = await identityFromSecretKey(decodeSecretKey(persisted));
			if (identity.publicKey[0] !== 0x02) throw new Error('non-canonical public key');
			return identity;
		} catch {
			throw new Error('invalid persisted WebVM FIPS identity');
		}
	}
	if (!crypto?.getRandomValues) {
		throw new Error('Secure browser randomness is unavailable');
	}

	for (;;) {
		const secretKey = crypto.getRandomValues(new Uint8Array(32));
		let identity;
		try {
			identity = await identityFromSecretKey(secretKey);
		} catch {
			continue;
		}
		// Scanned FIPS routes use the compact x-only Nostr key. Keep the full
		// key on its canonical even-parity representation so native peers
		// reconstruct this same WebRTC identity after every browser reload.
		if (identity.publicKey[0] !== 0x02) continue;
		identityStorage.setItem(
			WEBVM_FIPS_IDENTITY_STORAGE_KEY,
			encodeSecretKey(secretKey),
		);
		return identity;
	}
}

export function clearWebvmFipsIdentity(storage = globalThis.localStorage) {
	requireStorage(storage).removeItem(WEBVM_FIPS_IDENTITY_STORAGE_KEY);
}
