import {
	FipsNode,
	identityFromSecretKey,
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

// Stable public FIPS mesh ingress operated by Iris. WebVM dials it directly
// instead of racing every ambient Nostr advert, which makes routing usable as
// soon as this one authenticated WebRTC link is ready.
export const DEFAULT_FIPS_GATEWAY_PUBKEY =
	'02e26bce966fbed46ae16780304026fe73e059d01991501948124944ffc3778c97';

function loadSecretKey() {
	if (!globalThis.crypto?.getRandomValues) {
		throw new Error('Secure browser randomness is unavailable');
	}
	return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

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
	gatewayPubkey = DEFAULT_FIPS_GATEWAY_PUBKEY,
	logger = noopLogger,
	onStatus = () => {},
} = {}) {
	const identity = await identityFromSecretKey(loadSecretKey());
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
		// The browser dials native adverts but does not advertise itself, which
		// keeps one owner for each WebRTC offer while providing guest transit.
		advertiseOnNostr: false,
		autoConnect: false,
		acceptConnections: true,
		mtu: WEBVM_FIPS_UNDERLAY_MTU,
		logger,
	});
	const node = new FipsNode({
		identity,
		transports: [ethernet, webrtc],
		forwarding: true,
		routingMode: 'tree',
		heartbeatIntervalMs: 1_000,
		logger,
	});
	const localEthernetPeers = new Set();
	const webrtcPeerKeys = new Set();
	let ethernetPeers = 0;
	let webrtcPeers = 0;
	let lastPeerError = '';
	let lastPeerErrorWhere = '';
	let gatewayConnected = false;
	let gatewayAttemptRunning = false;
	let gatewayRetryTimer;
	let stopping = false;
	const normalizedGatewayPubkey = gatewayPubkey?.toLowerCase() || '';
	const scheduleGatewayConnect = (delayMs = 0) => {
		if (!normalizedGatewayPubkey || stopping || gatewayConnected || gatewayRetryTimer) return;
		gatewayRetryTimer = setTimeout(() => {
			gatewayRetryTimer = undefined;
			void connectGateway();
		}, delayMs);
	};
	const connectGateway = async () => {
		if (stopping || gatewayConnected || gatewayAttemptRunning) return;
		gatewayAttemptRunning = true;
		try {
			await node.connect({ transport: 'webrtc', addr: normalizedGatewayPubkey });
		} catch (error) {
			lastPeerError = error instanceof Error ? error.message : String(error);
			lastPeerErrorWhere = 'connect FIPS gateway';
			publishStatus();
		} finally {
			gatewayAttemptRunning = false;
			if (!gatewayConnected) scheduleGatewayConnect(2_000);
		}
	};
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
			if (connected) webrtcPeerKeys.add(peer);
			else webrtcPeerKeys.delete(peer);
			if (peer === normalizedGatewayPubkey) {
				gatewayConnected = connected;
				if (!connected) scheduleGatewayConnect();
			}
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
		scheduleGatewayConnect();
		publishStatus();
	} catch (error) {
		removePeerListener?.();
		removeErrorListener?.();
		await node.stop().catch(() => {});
		for (const client of sharedRelayClients) client.close();
		throw error;
	}

	return {
		identity,
		node,
		ethernet,
		webrtc,
		ethernetFrameStats: framePort.stats,
		async stop() {
			stopping = true;
			if (gatewayRetryTimer) clearTimeout(gatewayRetryTimer);
			gatewayRetryTimer = undefined;
			removePeerListener?.();
			removeErrorListener?.();
			await node.stop();
			for (const client of sharedRelayClients) client.close();
		},
	};
}
