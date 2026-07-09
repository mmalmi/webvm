import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

const STORAGE_KEY = 'iris-webvm.nostr-vpn.identity.v1';
const DEFAULT_NODE_NAME = 'Iris WebVM';

function hexFromBytes(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteLength) {
	const bytes = new Uint8Array(byteLength);
	if (browser && globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return hexFromBytes(bytes);
}

function isHex64(value) {
	return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function createIdentity() {
	return {
		appKeyHex: randomHex(32),
		nodeName: DEFAULT_NODE_NAME,
		createdAt: new Date().toISOString(),
	};
}

function readIdentity() {
	if (!browser) {
		return createIdentity();
	}

	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
		if (stored && isHex64(stored.appKeyHex)) {
			return {
				appKeyHex: stored.appKeyHex.toLowerCase(),
				nodeName: String(stored.nodeName || DEFAULT_NODE_NAME).slice(0, 80),
				createdAt: stored.createdAt || new Date().toISOString(),
			};
		}
	} catch {
		// A malformed local entry should not keep the panel from opening.
	}

	return createIdentity();
}

function persistIdentity(identity) {
	if (!browser) {
		return;
	}
	localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export const nostrVpnIdentity = writable(readIdentity());
export const nostrVpnAction = writable('idle');

nostrVpnIdentity.subscribe((identity) => persistIdentity(identity));

export function createJoinRequestLink(identity = get(nostrVpnIdentity)) {
	const appKeyHex = identity?.appKeyHex || randomHex(32);
	const nodeName = identity?.nodeName || DEFAULT_NODE_NAME;
	return `nvpn://join-request?app_key=${encodeURIComponent(appKeyHex)}&name=${encodeURIComponent(nodeName)}`;
}

export function updateNostrVpnNodeName(nodeName) {
	const trimmed = String(nodeName || '').trim().slice(0, 80) || DEFAULT_NODE_NAME;
	nostrVpnIdentity.update((identity) => ({ ...identity, nodeName: trimmed }));
	nostrVpnAction.set('saved');
}

export function resetNostrVpnIdentity() {
	nostrVpnIdentity.set(createIdentity());
	nostrVpnAction.set('reset');
}

export function markJoinRequestOpened() {
	nostrVpnAction.set('opened');
}

export async function copyJoinRequestLink() {
	if (!browser || !navigator.clipboard?.writeText) {
		nostrVpnAction.set('copy-unavailable');
		return false;
	}

	await navigator.clipboard.writeText(createJoinRequestLink());
	nostrVpnAction.set('copied');
	return true;
}
