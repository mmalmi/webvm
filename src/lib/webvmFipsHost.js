import {
	FipsNode,
	nodeAddrToHex,
	noopLogger,
	toHex,
} from '@fips/core';
import { VirtualEthernetTransport } from '@fips/transport-ethernet';
import {
	FIPS_DEFAULT_DISCOVERY_APP,
	NostrRelayClient,
	WebRtcTransport,
} from '@fips/transport-webrtc';
import { createV86EthernetFramePort } from '$lib/v86EthernetFramePort.js';
import { loadOrCreateWebvmFipsIdentity } from '$lib/webvmFipsIdentity.js';
import {
	loadPreferredWebvmFipsIngresses,
	rememberWebvmFipsIngress,
} from '$lib/webvmFipsIngress.js';
import { createWebvmNostrPubsubService } from '$lib/webvmNostrPubsubService.js';

export const DEFAULT_FIPS_RELAYS = Object.freeze([
	'wss://temp.iris.to',
	'wss://relay.damus.io',
	'wss://nos.lol',
]);

export const DEFAULT_FIPS_STUN_SERVERS = Object.freeze([
	'stun:stun.iris.to:3478',
	'stun:stun.l.google.com:19302',
	'stun:stun.cloudflare.com:3478',
]);

export const WEBVM_FIPS_UNDERLAY_MTU = 1280;

function macForIdentity(identity) {
	const mac = new Uint8Array(6);
	mac[0] = 0x02;
	mac.set(identity.xOnlyPubkey.subarray(identity.xOnlyPubkey.length - 5), 1);
	return mac;
}

export async function createWebvmFipsHost({
	emulator,
	relays = DEFAULT_FIPS_RELAYS,
	relayClients,
	discoveryApp = FIPS_DEFAULT_DISCOVERY_APP,
	stunServers = DEFAULT_FIPS_STUN_SERVERS,
	logger = noopLogger,
	onStatus = () => {},
} = {}) {
	const identity = await loadOrCreateWebvmFipsIdentity();
	const preferredIngresses = loadPreferredWebvmFipsIngresses();
	const sharedRelayClients = relayClients || relays.map((url) => new NostrRelayClient({
		url,
		logger,
	}));
	const framePort = createV86EthernetFramePort(emulator);
	const ethernet = new VirtualEthernetTransport({
		port: framePort,
		localMac: macForIdentity(identity),
		mtu: WEBVM_FIPS_UNDERLAY_MTU,
		discovery: false,
		announce: true,
		discoveryScope: discoveryApp,
		beaconIntervalMs: 10_000,
	});
	const webrtc = new WebRtcTransport({
		relays: [...relays],
		relayClients: sharedRelayClients,
		stunServers,
		discoveryApp,
		// The browser identity survives reloads, so advertise it and refresh the
		// advert while this tab is alive. Mesh peers can then reconnect inbound
		// through these configured relays instead of stale third-party relays.
		advertiseOnNostr: true,
		// Roster peers are often behind an ingress and do not advertise WebRTC
		// themselves. Reconnect proven ingresses first, while keeping enough
		// parallel capacity to find a healthy ingress on a fresh browser.
		autoConnect: true,
		acceptConnections: true,
		maxConnections: 16,
		maxAutoConnections: 8,
		preferredAutoConnectPeers: preferredIngresses,
		connectTimeoutMs: 12_000,
		iceGatherTimeoutMs: 2_000,
		mtu: WEBVM_FIPS_UNDERLAY_MTU,
		logger,
	});
	const node = new FipsNode({
		identity,
		transports: [ethernet, webrtc],
		forwarding: true,
		routingMode: 'reply_learned',
		heartbeatIntervalMs: 1_000,
		logger,
	});
	const localEthernetPeers = new Set();
	const pubsub = createWebvmNostrPubsubService({
		node,
		relayClients: sharedRelayClients,
		authorizePeer: (peer) => localEthernetPeers.has(peer),
		localPeers: () => [...localEthernetPeers],
		onDirectApprovalPeer: rememberWebvmFipsIngress,
		logger,
	});
	const webrtcPeerKeys = new Set();
	let ethernetPeers = 0;
	let webrtcPeers = 0;
	let lastPeerError = '';
	let lastPeerErrorWhere = '';
	const publishStatus = (state = 'ready', error = '') => {
		onStatus({
			state,
			error,
			lastPeerError,
			lastPeerErrorWhere,
			publicKeyHex: toHex(identity.publicKey),
			nodeAddrHex: nodeAddrToHex(identity.nodeAddr),
			ethernetPeers,
			webrtcPeers,
		});
	};
	const removePeerListener = node.on('peer', (event) => {
		const peer = String(event?.remotePubkey || '').toLowerCase();
		const connected = event?.state === 'connected';
		if (event?.remoteAddr?.transport === 'ethernet') {
			if (connected) {
				localEthernetPeers.add(peer);
			} else {
				localEthernetPeers.delete(peer);
			}
		}
		if (event?.remoteAddr?.transport === 'webrtc') {
			if (connected) {
				webrtcPeerKeys.add(peer);
			}
			else webrtcPeerKeys.delete(peer);
		}
		ethernetPeers = localEthernetPeers.size;
		webrtcPeers = webrtcPeerKeys.size;
		publishStatus();
	});
	const removeErrorListener = node.on('error', (event) => {
		lastPeerError = event?.err instanceof Error
			? event.err.message
			: String(event?.err || 'FIPS peer error');
		lastPeerErrorWhere = String(event?.where || 'unknown');
		publishStatus();
	});

	publishStatus('starting');
	try {
		await node.start();
		publishStatus();
	} catch (error) {
		removePeerListener?.();
		removeErrorListener?.();
		await pubsub.stop();
		await node.stop().catch(() => {});
		for (const client of sharedRelayClients) client.close();
		throw error;
	}

	return {
		identity,
		node,
		ethernet,
		webrtc,
		pubsub,
		ethernetFrameStats: framePort.stats,
		async stop() {
			removePeerListener?.();
			removeErrorListener?.();
			await pubsub.stop();
			await node.stop();
			for (const client of sharedRelayClients) client.close();
		},
	};
}
