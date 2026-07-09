import { browser } from '$app/environment';
import {
	SimplePool,
	finalizeEvent,
	generateSecretKey,
	getPublicKey,
	nip19,
	nip44,
	verifyEvent,
} from 'nostr-tools';
import { get, writable } from 'svelte/store';
import { getNostrVpnTransportStatus } from '$lib/nostrVpnTransport.js';

const STORAGE_KEY = 'iris-webvm.nostr-vpn.identity.v2';
const DEFAULT_NODE_NAME = 'Iris WebVM';
const JOIN_REQUEST_PREFIX = 'nvpn://join-request/';
const JOIN_REQUEST_TYPE = 'nostr-vpn.join-request';
const PROOF_KIND = 7368;
const PROOF_TYPE = 'nostr_identity_device_approval_proof';
const RECEIPT_TYPE = 'nostr_identity_device_approval_receipt';
const DEFAULT_RECEIPT_RELAYS = ['wss://temp.iris.to', 'wss://relay.damus.io', 'wss://nos.lol'];

let receiptPool;
let receiptSubscription;
let subscribedRequestPubkey = '';
let subscribedReceiptRelayKey = '';

function bytesToHex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function randomBase64Url(byteLength) {
	const bytes = new Uint8Array(byteLength);
	if (browser && globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return bytesToBase64Url(bytes);
}

function base64UrlEncode(value) {
	const bytes = new TextEncoder().encode(value);
	return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes) {
	if (typeof btoa === 'function') {
		let binary = '';
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
	}
	return Buffer.from(bytes).toString('base64url');
}

function isHex64(value) {
	return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function cleanNodeName(value) {
	return String(value || '').trim().slice(0, 80) || DEFAULT_NODE_NAME;
}

function createIdentity() {
	const appSecretKey = generateSecretKey();
	const requestSecretKey = generateSecretKey();
	const appSecretKeyHex = bytesToHex(appSecretKey);
	const requestSecretKeyHex = bytesToHex(requestSecretKey);
	return {
		appSecretKeyHex,
		appPubkeyHex: getPublicKey(appSecretKey),
		requestSecretKeyHex,
		requestPubkeyHex: getPublicKey(requestSecretKey),
		requestSecret: randomBase64Url(32),
		requestedAt: Math.floor(Date.now() / 1000),
		nodeName: DEFAULT_NODE_NAME,
		createdAt: new Date().toISOString(),
		paired: null,
	};
}

function normalizeIdentity(stored) {
	if (
		stored &&
		isHex64(stored.appSecretKeyHex) &&
		isHex64(stored.appPubkeyHex) &&
		isHex64(stored.requestSecretKeyHex) &&
		isHex64(stored.requestPubkeyHex) &&
		typeof stored.requestSecret === 'string' &&
		stored.requestSecret.length >= 32
	) {
		return {
			appSecretKeyHex: stored.appSecretKeyHex.toLowerCase(),
			appPubkeyHex: stored.appPubkeyHex.toLowerCase(),
			requestSecretKeyHex: stored.requestSecretKeyHex.toLowerCase(),
			requestPubkeyHex: stored.requestPubkeyHex.toLowerCase(),
			requestSecret: stored.requestSecret.trim(),
			requestedAt: Number.isFinite(stored.requestedAt) ? stored.requestedAt : Math.floor(Date.now() / 1000),
			nodeName: cleanNodeName(stored.nodeName),
			createdAt: stored.createdAt || new Date().toISOString(),
			paired: stored.paired || null,
		};
	}
	return null;
}

function readIdentity() {
	if (!browser) {
		return createIdentity();
	}

	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
		const identity = normalizeIdentity(stored);
		if (identity) {
			return identity;
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

function buildProofEvent(identity) {
	const tags = [
		['type', PROOF_TYPE],
		['request_pubkey', identity.requestPubkeyHex],
		['requested_at', String(identity.requestedAt)],
		['request_type', JOIN_REQUEST_TYPE],
	];
	if (identity.nodeName.trim()) {
		tags.push(['label', identity.nodeName.trim()]);
	}
	return finalizeEvent(
		{
			kind: PROOF_KIND,
			created_at: identity.requestedAt,
			tags,
			content: '',
		},
		hexToBytes(identity.appSecretKeyHex),
	);
}

function createApprovalRequestPayload(identity) {
	return {
		v: 1,
		requestNpub: nip19.npubEncode(identity.requestPubkeyHex),
		deviceAppKeyNpub: nip19.npubEncode(identity.appPubkeyHex),
		requestSecret: identity.requestSecret,
		deviceAppKeyProof: JSON.stringify(buildProofEvent(identity)),
		requestedAt: identity.requestedAt,
		requestType: JOIN_REQUEST_TYPE,
		label: identity.nodeName.trim(),
	};
}

function eventHasTag(event, name, value) {
	return Array.isArray(event?.tags)
		&& event.tags.some((tag) => Array.isArray(tag) && tag[0] === name && tag[1] === value);
}

function parseApprovalReceiptEvent(event, identity = get(nostrVpnIdentity)) {
	if (!event || event.kind !== PROOF_KIND || !verifyEvent(event)) {
		return null;
	}
	if (!eventHasTag(event, 'type', RECEIPT_TYPE) || !eventHasTag(event, 'p', identity.requestPubkeyHex)) {
		return null;
	}
	const conversationKey = nip44.v2.utils.getConversationKey(
		hexToBytes(identity.requestSecretKeyHex),
		event.pubkey,
	);
	const receipt = JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
	if (
		receipt.schema !== 1
		|| receipt.requestPubkey !== identity.requestPubkeyHex
		|| receipt.deviceAppKeyPubkey !== identity.appPubkeyHex
		|| receipt.approvedByPubkey !== event.pubkey
		|| receipt.approvedAt !== event.created_at
		|| receipt.requestSecret !== identity.requestSecret
	) {
		return null;
	}
	return receipt;
}

export const nostrVpnIdentity = writable(readIdentity());
export const nostrVpnAction = writable('idle');

nostrVpnIdentity.subscribe((identity) => persistIdentity(identity));

export function createJoinRequestLink(identity = get(nostrVpnIdentity)) {
	return `${JOIN_REQUEST_PREFIX}${base64UrlEncode(JSON.stringify(createApprovalRequestPayload(identity)))}`;
}

export function updateNostrVpnNodeName(nodeName) {
	const trimmed = cleanNodeName(nodeName);
	nostrVpnIdentity.update((identity) => ({
		...identity,
		nodeName: trimmed,
		paired: null,
	}));
	nostrVpnAction.set('saved');
}

export function resetNostrVpnIdentity() {
	nostrVpnIdentity.set(createIdentity());
	nostrVpnAction.set('reset');
}

export function markJoinRequestOpened() {
	nostrVpnAction.set('opened');
}

export function markNostrVpnPaired(detail = {}) {
	const requestSecret = String(detail.requestSecret || detail.request_secret || '').trim();
	const identity = get(nostrVpnIdentity);
	if (requestSecret !== identity.requestSecret) {
		nostrVpnAction.set('pairing-mismatch');
		return false;
	}

	nostrVpnIdentity.update((current) => ({
		...current,
		paired: {
			pairedAt: new Date().toISOString(),
			adminNpub: String(detail.adminNpub || detail.admin_npub || ''),
			networkName: String(detail.networkName || detail.network_name || ''),
			profileId: String(detail.profileId || detail.profile_id || ''),
			rosterOpId: String(detail.rosterOpId || detail.roster_op_id || ''),
		},
	}));
	nostrVpnAction.set('paired');
	return true;
}

export function handleNostrVpnApprovalReceiptEvent(event) {
	try {
		const receipt = parseApprovalReceiptEvent(event);
		if (!receipt) {
			return false;
		}
		return markNostrVpnPaired({
			requestSecret: receipt.requestSecret,
			adminNpub: nip19.npubEncode(receipt.approvedByPubkey),
			networkName: receipt.profileId,
			profileId: receipt.profileId,
			rosterOpId: receipt.rosterOpId || '',
		});
	} catch {
		return false;
	}
}

export function startNostrVpnReceiptListener(relays = DEFAULT_RECEIPT_RELAYS) {
	if (!browser) {
		return false;
	}
	const identity = get(nostrVpnIdentity);
	if (identity.paired) {
		receiptSubscription?.close?.();
		subscribedRequestPubkey = '';
		subscribedReceiptRelayKey = '';
		return false;
	}
	const relayKey = relays.map((relay) => String(relay).trim()).filter(Boolean).join('\n');
	if (subscribedRequestPubkey === identity.requestPubkeyHex && subscribedReceiptRelayKey === relayKey) {
		return false;
	}
	receiptSubscription?.close?.();
	receiptPool ||= new SimplePool();
	subscribedRequestPubkey = identity.requestPubkeyHex;
	subscribedReceiptRelayKey = relayKey;
	receiptSubscription = receiptPool.subscribeMany(
		relays,
		{
			kinds: [PROOF_KIND],
			'#p': [identity.requestPubkeyHex],
			'#type': [RECEIPT_TYPE],
			since: Math.max(0, identity.requestedAt - 60),
		},
		{
			onevent: handleNostrVpnApprovalReceiptEvent,
		},
	);
	return true;
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

if (browser) {
	globalThis.irisWebvmNostrVpn = {
		acceptPairing: markNostrVpnPaired,
		acceptApprovalReceipt: handleNostrVpnApprovalReceiptEvent,
		joinRequestLink: createJoinRequestLink,
		startReceiptListener: startNostrVpnReceiptListener,
		transportStatus: getNostrVpnTransportStatus,
	};
	globalThis.addEventListener('nvpn:join-request-accepted', (event) => {
		markNostrVpnPaired(event.detail || {});
	});
	globalThis.addEventListener('nvpn:approval-receipt', (event) => {
		handleNostrVpnApprovalReceiptEvent(event.detail?.event || event.detail);
	});
}
