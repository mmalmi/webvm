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
import { WebSocketTransport } from '@fips/transport-websocket';
import { createV86EthernetFramePort } from '$lib/v86EthernetFramePort.js';
import { createOptionalFipsTransport } from '$lib/optionalFipsTransport.js';
import {
	DEFAULT_FIPS_RELAYS,
	DEFAULT_FIPS_STUN_SERVERS,
	DEFAULT_FIPS_WEBSOCKET_SEED_URLS,
	WEBVM_FIPS_UNDERLAY_MTU,
} from '$lib/webvmFipsConfig.js';
import { loadOrCreateWebvmFipsIdentity } from '$lib/webvmFipsIdentity.js';
import { createWebvmNostrPubsubService } from '$lib/webvmNostrPubsubService.js';

export {
	DEFAULT_FIPS_RELAYS,
	DEFAULT_FIPS_STUN_SERVERS,
	DEFAULT_FIPS_WEBSOCKET_SEED_URLS,
	WEBVM_FIPS_UNDERLAY_MTU,
} from '$lib/webvmFipsConfig.js';

export const WEBVM_NOSTR_PUBSUB_FILTERS = Object.freeze([
	Object.freeze({ kinds: Object.freeze([37_195, 37_196, 7_368]) }),
	Object.freeze({ kinds: Object.freeze([30_064, 30_078]) }),
]);

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
	websocketSeedUrls = DEFAULT_FIPS_WEBSOCKET_SEED_URLS,
	discoveryApp = FIPS_DEFAULT_DISCOVERY_APP,
	stunServers = DEFAULT_FIPS_STUN_SERVERS,
	logger = noopLogger,
	onStatus = () => {},
} = {}) {
	const identity = await loadOrCreateWebvmFipsIdentity();
	const sharedRelayClients = relayClients || relays.map((url) => new NostrRelayClient({
		url,
		logger,
	}));
	const carrierErrors = [];
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
	const websocket = new WebSocketTransport({
		seedUrls: [...websocketSeedUrls],
		mtu: WEBVM_FIPS_UNDERLAY_MTU,
		logger,
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
		connectTimeoutMs: 12_000,
		iceGatherTimeoutMs: 2_000,
		mtu: WEBVM_FIPS_UNDERLAY_MTU,
		logger,
	});
	const node = new FipsNode({
		identity,
		transports: [
			ethernet,
			websocket,
			createOptionalFipsTransport(webrtc, {
				logger,
				onUnavailable: ({ type, error }) => {
					carrierErrors.push({ type, error: error?.message || String(error) });
				},
			}),
		],
		forwarding: true,
		routingMode: 'reply_learned',
		heartbeatIntervalMs: 1_000,
		logger,
	});
	const localEthernetPeers = new Set();
	const pubsub = await createWebvmNostrPubsubService({
		node,
		localPeerId: toHex(identity.publicKey),
		peers: () => [...localEthernetPeers],
		filters: WEBVM_NOSTR_PUBSUB_FILTERS,
		relayClients: sharedRelayClients,
		authorizePeer: (peer) => localEthernetPeers.has(peer),
		logger,
	});
	const webrtcPeerKeys = new Set();
	const websocketPeerKeys = new Set();
	let ethernetPeers = 0;
	let webrtcPeers = 0;
	let websocketPeers = 0;
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
			websocketPeers,
			websocketStats: websocket.stats(),
			carrierErrors: [...carrierErrors],
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
			pubsub.refreshPeers();
		}
		if (event?.remoteAddr?.transport === 'webrtc') {
			if (connected) {
				webrtcPeerKeys.add(peer);
			}
			else webrtcPeerKeys.delete(peer);
		}
		if (event?.remoteAddr?.transport === 'websocket') {
			if (connected) {
				websocketPeerKeys.add(peer);
			}
			else websocketPeerKeys.delete(peer);
		}
		ethernetPeers = localEthernetPeers.size;
		webrtcPeers = webrtcPeerKeys.size;
		websocketPeers = websocketPeerKeys.size;
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
		websocket,
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
