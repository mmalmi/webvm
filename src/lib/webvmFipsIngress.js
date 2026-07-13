export const WEBVM_FIPS_INGRESS_STORAGE_KEY = 'iris-webvm:fips-ingress-peers:v2';

const MAX_PREFERRED_INGRESSES = 4;
const COMPRESSED_PUBKEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;

function requireStorage(storage) {
	if (!storage?.getItem || !storage?.setItem || !storage?.removeItem) {
		throw new Error('WebVM FIPS ingress storage is unavailable');
	}
	return storage;
}

export function loadPreferredWebvmFipsIngresses(storage = globalThis.localStorage) {
	const value = requireStorage(storage).getItem(WEBVM_FIPS_INGRESS_STORAGE_KEY);
	if (value === null) return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return [...new Set(parsed
			.map((peer) => String(peer).toLowerCase())
			.filter((peer) => COMPRESSED_PUBKEY_PATTERN.test(peer)))]
			.slice(0, MAX_PREFERRED_INGRESSES);
	} catch {
		return [];
	}
}

export function rememberWebvmFipsIngress(peer, storage = globalThis.localStorage) {
	const normalized = String(peer).toLowerCase();
	if (!COMPRESSED_PUBKEY_PATTERN.test(normalized)) return;
	const preferred = loadPreferredWebvmFipsIngresses(storage)
		.filter((entry) => entry !== normalized);
	preferred.unshift(normalized);
	requireStorage(storage).setItem(
		WEBVM_FIPS_INGRESS_STORAGE_KEY,
		JSON.stringify(preferred.slice(0, MAX_PREFERRED_INGRESSES)),
	);
}

export function clearPreferredWebvmFipsIngresses(storage = globalThis.localStorage) {
	requireStorage(storage).removeItem(WEBVM_FIPS_INGRESS_STORAGE_KEY);
}
