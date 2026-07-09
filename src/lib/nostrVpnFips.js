import {
	FipsNode,
	fromHex,
	identityFromSecretKey,
	nodeAddrToHex,
	noopLogger,
	toHex,
} from '@fips/core';
import {
	FIPS_DEFAULT_DISCOVERY_APP,
	WebRtcTransport,
} from '@fips/transport-webrtc';
import {
	createEndpointDataBridge,
	validatePacketBackend,
} from '$lib/nostrVpnTransport.js';

export const DEFAULT_FIPS_RELAYS = Object.freeze([
	'wss://temp.iris.to',
	'wss://relay.damus.io',
	'wss://nos.lol',
]);

function isHex(value, length) {
	return typeof value === 'string'
		&& value.length === length
		&& /^[0-9a-f]+$/i.test(value);
}

export function normalizeFipsRelays(relays = DEFAULT_FIPS_RELAYS) {
	const relayList = Array.isArray(relays) ? relays : [relays];
	const cleaned = [...new Set(
		relayList
			.map((relay) => String(relay || '').trim())
			.filter(Boolean),
	)];
	if (cleaned.length === 0) {
		throw new TypeError('Nostr VPN FIPS relays are missing');
	}
	return cleaned;
}

export async function createNostrVpnFipsSession({
	identity,
	relays = DEFAULT_FIPS_RELAYS,
	stunServers = [],
	discoveryApp = FIPS_DEFAULT_DISCOVERY_APP,
	advertiseOnNostr = true,
	autoConnect = true,
	acceptConnections = true,
	packetBackend = null,
	exitPeerPubkeyHex = '',
	logger = noopLogger,
} = {}) {
	if (!identity || !isHex(identity.appSecretKeyHex, 64)) {
		throw new TypeError('Nostr VPN FIPS session requires the paired AppKey secret');
	}
	const relayList = normalizeFipsRelays(relays);
	const fipsIdentity = await identityFromSecretKey(fromHex(identity.appSecretKeyHex));
	const publicKeyHex = toHex(fipsIdentity.publicKey);
	const xOnlyPubkeyHex = toHex(fipsIdentity.xOnlyPubkey);
	const nodeAddrHex = nodeAddrToHex(fipsIdentity.nodeAddr);

	if (identity.appPubkeyHex && xOnlyPubkeyHex !== identity.appPubkeyHex.toLowerCase()) {
		throw new Error('Nostr VPN AppKey pubkey does not match the FIPS identity');
	}

	let packetBridgeStop = null;
	const node = new FipsNode({
		identity: fipsIdentity,
		transports: [
			new WebRtcTransport({
				relays: relayList,
				stunServers,
				discoveryApp,
				advertiseOnNostr,
				autoConnect,
				acceptConnections,
				logger,
			}),
		],
		forwarding: false,
		logger,
	});

	await node.start();

	if (packetBackend) {
		validatePacketBackend(packetBackend);
		if (!isHex(exitPeerPubkeyHex, 66)) {
			throw new TypeError('Nostr VPN packet bridge requires a 33-byte compressed exit peer pubkey');
		}
		const exitPeerAddr = exitPeerPubkeyHex.toLowerCase();
		await node.connect({ transport: 'webrtc', addr: exitPeerAddr });
		packetBridgeStop = createEndpointDataBridge({
			packetBackend,
			fipsNode: node,
			dst: exitPeerAddr,
		});
	}

	const status = {
		state: packetBridgeStop
			? 'fips-packet-bridge-ready'
			: 'fips-ready-packet-backend-unavailable',
		canRouteVmTraffic: Boolean(packetBridgeStop),
		connected: false,
		summary: packetBridgeStop
			? 'FIPS transport ready'
			: 'FIPS transport ready; VM packet backend unavailable',
		publicKeyHex,
		xOnlyPubkeyHex,
		nodeAddrHex,
		relays: relayList,
		discoveryApp,
		transport: 'webrtc',
		packetBridgeAttached: Boolean(packetBridgeStop),
	};

	return {
		node,
		status,
		async stop() {
			packetBridgeStop?.();
			packetBridgeStop = null;
			await node.stop();
		},
	};
}
