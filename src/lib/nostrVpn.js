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
import {
	FIPS_ADVERT_KIND,
	FIPS_DEFAULT_DISCOVERY_APP,
} from '@fips/transport-webrtc';
import {
	DEFAULT_FIPS_RELAYS,
	createNostrVpnFipsSession,
	normalizeFipsRelays,
} from '$lib/nostrVpnFips.js';
import { getNostrVpnTransportStatus } from '$lib/nostrVpnTransport.js';

const STORAGE_KEY = 'iris-webvm.nostr-vpn.identity.v2';
const DEFAULT_NODE_NAME = 'Iris WebVM';
const JOIN_REQUEST_PREFIX = 'nvpn://join-request/';
const JOIN_REQUEST_TYPE = 'nostr-vpn.join-request';
const PROOF_KIND = 7368;
const PROOF_TYPE = 'nostr_identity_device_approval_proof';
const RECEIPT_TYPE = 'nostr_identity_device_approval_receipt';
const APPROVAL_CONTEXT_TYPE = 'nostr-vpn.join-request-approval-context';
const DEFAULT_RECEIPT_RELAYS = ['wss://temp.iris.to', 'wss://relay.damus.io', 'wss://nos.lol'];

let receiptPool;
let receiptSubscription;
let subscribedRequestPubkey = '';
let subscribedReceiptRelayKey = '';
let lastReceiptRelays = DEFAULT_FIPS_RELAYS;
let fipsSession = null;
let fipsSessionRelayKey = '';
let fipsSessionPubkey = '';
let pendingApprovalContext = null;

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

function isCompressedPubkeyHex(value) {
	return typeof value === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(value);
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

function parseApprovalContextEvent(event, identity = get(nostrVpnIdentity)) {
	if (!event || event.kind !== PROOF_KIND || !verifyEvent(event)) {
		return null;
	}
	if (!eventHasTag(event, 'type', APPROVAL_CONTEXT_TYPE) || !eventHasTag(event, 'p', identity.requestPubkeyHex)) {
		return null;
	}
	const conversationKey = nip44.v2.utils.getConversationKey(
		hexToBytes(identity.requestSecretKeyHex),
		event.pubkey,
	);
	const context = JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
	if (
		context.schema !== 1
		|| context.requestPubkey !== identity.requestPubkeyHex
		|| context.deviceAppKeyPubkey !== identity.appPubkeyHex
		|| context.approvedByPubkey !== event.pubkey
		|| context.approvedAt !== event.created_at
		|| context.requestSecret !== identity.requestSecret
		|| typeof context.meshNetworkId !== 'string'
		|| context.meshNetworkId.trim().length === 0
	) {
		return null;
	}
	return {
		schema: 1,
		profileId: String(context.profileId || ''),
		requestPubkey: context.requestPubkey,
		deviceAppKeyPubkey: context.deviceAppKeyPubkey,
		approvedByPubkey: context.approvedByPubkey,
		approvedAt: context.approvedAt,
		requestSecret: context.requestSecret,
		meshNetworkId: context.meshNetworkId.trim(),
		networkName: String(context.networkName || '').trim(),
		rosterOpId: String(context.rosterOpId || '').trim(),
	};
}

function contextMatchesReceipt(context, receipt) {
	return Boolean(
		context
		&& receipt
		&& context.requestPubkey === receipt.requestPubkey
		&& context.deviceAppKeyPubkey === receipt.deviceAppKeyPubkey
		&& context.approvedByPubkey === receipt.approvedByPubkey
		&& context.approvedAt === receipt.approvedAt
		&& context.requestSecret === receipt.requestSecret
		&& (!context.profileId || context.profileId === receipt.profileId)
	);
}

function mergeApprovalContext(context) {
	if (!context) {
		return false;
	}
	let merged = false;
	nostrVpnIdentity.update((identity) => {
		if (
			context.requestSecret !== identity.requestSecret
			|| context.requestPubkey !== identity.requestPubkeyHex
			|| context.deviceAppKeyPubkey !== identity.appPubkeyHex
			|| !identity.paired
			|| (
				identity.paired.adminPubkeyHex
				&& identity.paired.adminPubkeyHex !== context.approvedByPubkey
			)
		) {
			return identity;
		}
		merged = true;
		return {
			...identity,
			paired: {
				...identity.paired,
				adminPubkeyHex: context.approvedByPubkey,
				meshNetworkId: context.meshNetworkId,
				networkName: context.networkName || identity.paired.networkName,
				profileId: context.profileId || identity.paired.profileId,
				rosterOpId: context.rosterOpId || identity.paired.rosterOpId,
			},
		};
	});
	if (merged) {
		void startNostrVpnFipsTransport().catch(() => {});
	}
	return merged;
}

function fipsAdvertEndpoint(event) {
	try {
		const advert = JSON.parse(event.content);
		const endpoint = advert.endpoints?.find((candidate) =>
			candidate?.transport === 'webrtc' && isCompressedPubkeyHex(candidate.addr)
		);
		return endpoint?.addr?.toLowerCase() || '';
	} catch {
		return '';
	}
}

async function waitForNativeFipsEndpoint({
	relays,
	author,
	discoveryApp = FIPS_DEFAULT_DISCOVERY_APP,
	timeoutMs = 15_000,
} = {}) {
	if (!isHex64(author)) {
		throw new Error('Nostr VPN native approval pubkey is required before attaching VM packets');
	}
	const relayList = normalizeFipsRelays(relays);
	const pool = new SimplePool();
	try {
		return await new Promise((resolve, reject) => {
			let subscription;
			const timer = setTimeout(() => {
				subscription?.close?.();
				reject(new Error('Nostr VPN native FIPS WebRTC advert was not found'));
			}, timeoutMs);
			subscription = pool.subscribeMany(
				relayList,
				{
					kinds: [FIPS_ADVERT_KIND],
					authors: [author],
					'#d': [discoveryApp],
				},
				{
					onevent(event) {
						const endpoint = fipsAdvertEndpoint(event);
						if (!endpoint) {
							return;
						}
						clearTimeout(timer);
						subscription?.close?.();
						resolve(endpoint);
					},
				},
			);
		});
	} finally {
		pool.close(relayList);
	}
}

export const nostrVpnIdentity = writable(readIdentity());
export const nostrVpnAction = writable('idle');
export const nostrVpnTransportStatus = writable(getNostrVpnTransportStatus());

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
	void stopNostrVpnFipsTransport();
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
			adminPubkeyHex: String(detail.adminPubkeyHex || detail.admin_pubkey_hex || detail.approvedByPubkey || ''),
			networkName: String(detail.networkName || detail.network_name || ''),
			profileId: String(detail.profileId || detail.profile_id || ''),
			rosterOpId: String(detail.rosterOpId || detail.roster_op_id || ''),
			meshNetworkId: String(detail.meshNetworkId || detail.mesh_network_id || ''),
		},
	}));
	nostrVpnAction.set('paired');
	void startNostrVpnFipsTransport().catch(() => {});
	return true;
}

export function handleNostrVpnApprovalReceiptEvent(event) {
	try {
		const receipt = parseApprovalReceiptEvent(event);
		if (!receipt) {
			return false;
		}
		const context = contextMatchesReceipt(pendingApprovalContext, receipt)
			? pendingApprovalContext
			: null;
		if (context) {
			pendingApprovalContext = null;
		}
		return markNostrVpnPaired({
			requestSecret: receipt.requestSecret,
			adminNpub: nip19.npubEncode(receipt.approvedByPubkey),
			adminPubkeyHex: receipt.approvedByPubkey,
			networkName: context?.networkName || receipt.profileId,
			profileId: receipt.profileId,
			rosterOpId: context?.rosterOpId || receipt.rosterOpId || '',
			meshNetworkId: context?.meshNetworkId || '',
		});
	} catch {
		return false;
	}
}

export function handleNostrVpnApprovalContextEvent(event) {
	try {
		const context = parseApprovalContextEvent(event);
		if (!context) {
			return false;
		}
		pendingApprovalContext = context;
		return mergeApprovalContext(context);
	} catch {
		return false;
	}
}

export function handleNostrVpnRelayEvent(event) {
	return handleNostrVpnApprovalReceiptEvent(event) || handleNostrVpnApprovalContextEvent(event);
}

export function startNostrVpnReceiptListener(relays = null) {
	if (!browser) {
		return false;
	}
	const identity = get(nostrVpnIdentity);
	const normalizedRelays = normalizeFipsRelays(relays || lastReceiptRelays || DEFAULT_RECEIPT_RELAYS);
	lastReceiptRelays = normalizedRelays;
	if (identity.paired) {
		receiptSubscription?.close?.();
		subscribedRequestPubkey = '';
		subscribedReceiptRelayKey = '';
		return false;
	}
	const relayKey = normalizedRelays.join('\n');
	if (subscribedRequestPubkey === identity.requestPubkeyHex && subscribedReceiptRelayKey === relayKey) {
		return false;
	}
	receiptSubscription?.close?.();
	receiptPool ||= new SimplePool();
	subscribedRequestPubkey = identity.requestPubkeyHex;
	subscribedReceiptRelayKey = relayKey;
	const approvalSub = receiptPool.subscribeMany(
		normalizedRelays,
		{
			kinds: [PROOF_KIND],
			'#p': [identity.requestPubkeyHex],
			since: Math.max(0, identity.requestedAt - 60),
		},
		{
			onevent: handleNostrVpnRelayEvent,
		},
	);
	receiptSubscription = {
		close() {
			approvalSub?.close?.();
		},
	};
	return true;
}

export async function startNostrVpnFipsTransport(options = {}) {
	if (!browser) {
		return get(nostrVpnTransportStatus);
	}
	const identity = get(nostrVpnIdentity);
	if (!identity.paired) {
		throw new Error('Nostr VPN pairing is required before starting FIPS transport');
	}
	const relays = normalizeFipsRelays(options.relays || lastReceiptRelays || DEFAULT_FIPS_RELAYS);
	const relayKey = relays.join('\n');
	const packetBridgeRequested = Boolean(options.packetBackend);
	let exitPeerPubkeyHex = options.exitPeerPubkeyHex || '';
	if (packetBridgeRequested) {
		if (!identity.paired.meshNetworkId) {
			throw new Error('Nostr VPN mesh network id is required before attaching VM packets');
		}
		if (!exitPeerPubkeyHex) {
			nostrVpnTransportStatus.set({
				...getNostrVpnTransportStatus(),
				state: 'fips-waiting-native-advert',
				summary: 'Waiting for native FIPS WebRTC advert',
				relays,
			});
			exitPeerPubkeyHex = await waitForNativeFipsEndpoint({
				relays,
				author: identity.paired.adminPubkeyHex,
				discoveryApp: options.discoveryApp,
				timeoutMs: options.nativeAdvertTimeoutMs,
			});
		}
	}
	if (
		fipsSession
		&& fipsSessionPubkey === identity.appPubkeyHex
		&& fipsSessionRelayKey === relayKey
		&& (!packetBridgeRequested || fipsSession.status.packetBridgeAttached)
	) {
		return fipsSession.status;
	}
	await stopNostrVpnFipsTransport();
	nostrVpnTransportStatus.set({
		...getNostrVpnTransportStatus(),
		state: 'fips-starting',
		summary: 'Starting FIPS transport',
		relays,
	});
	try {
		fipsSession = await createNostrVpnFipsSession({
			identity,
			relays,
			stunServers: options.stunServers || [],
			discoveryApp: options.discoveryApp,
			advertiseOnNostr: options.advertiseOnNostr ?? true,
			autoConnect: options.autoConnect ?? true,
			acceptConnections: options.acceptConnections ?? true,
			packetBackend: options.packetBackend || null,
			exitPeerPubkeyHex,
			logger: options.logger,
		});
		fipsSessionRelayKey = relayKey;
		fipsSessionPubkey = identity.appPubkeyHex;
		nostrVpnTransportStatus.set(fipsSession.status);
		return fipsSession.status;
	} catch (error) {
		fipsSession = null;
		fipsSessionRelayKey = '';
		fipsSessionPubkey = '';
		nostrVpnTransportStatus.set({
			...getNostrVpnTransportStatus(),
			state: 'fips-start-failed',
			summary: error instanceof Error ? error.message : 'FIPS transport failed to start',
			relays,
		});
		throw error;
	}
}

export async function stopNostrVpnFipsTransport() {
	const session = fipsSession;
	fipsSession = null;
	fipsSessionRelayKey = '';
	fipsSessionPubkey = '';
	if (session) {
		await session.stop();
	}
	nostrVpnTransportStatus.set(getNostrVpnTransportStatus());
	return get(nostrVpnTransportStatus);
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
		acceptApprovalContext: handleNostrVpnApprovalContextEvent,
		acceptRelayEvent: handleNostrVpnRelayEvent,
		joinRequestLink: createJoinRequestLink,
		startReceiptListener: startNostrVpnReceiptListener,
		startFipsTransport: startNostrVpnFipsTransport,
		stopFipsTransport: stopNostrVpnFipsTransport,
		transportStatus: () => get(nostrVpnTransportStatus),
	};
	globalThis.addEventListener('nvpn:join-request-accepted', (event) => {
		markNostrVpnPaired(event.detail || {});
	});
	globalThis.addEventListener('nvpn:approval-receipt', (event) => {
		handleNostrVpnApprovalReceiptEvent(event.detail?.event || event.detail);
	});
}
