import { expect, test } from '@playwright/test';
import {
	FipsNode,
	identityFromSecretKey,
	toHex,
} from '@fips/core';
import {
	FIPS_NOSTR_PUBSUB_SERVICE_PORT,
	FipsNostrPubsubClient,
} from 'nostr-pubsub';
import { finalizeEvent } from 'nostr-tools/pure';
import { createWebvmNostrPubsubService } from '../../src/lib/webvmNostrPubsubService.js';
import {
	event,
	hostPeerId,
	MemoryFipsNetwork,
	MemoryRelayClient,
	MemoryTransport,
	MemoryTransportHub,
	peerId,
} from './webvm-nostr-pubsub-fixtures.js';

const FILTERS = [{ kinds: [7368], '#p': ['1'.repeat(64)], limit: 8 }];

function nextEvent(createdAt, content) {
	return finalizeEvent({
		kind: 7368,
		created_at: createdAt,
		tags: [['p', '1'.repeat(64)]],
		content,
	}, new Uint8Array(32).fill(9));
}

async function settle(bridge, ...clients) {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		await bridge.idle();
		await Promise.all(clients.map((client) => client.idle()));
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test('WebVM routes relay history and live events plus FIPS publications without echoes', async () => {
	const network = new MemoryFipsNetwork();
	const hostNode = network.node(hostPeerId);
	const guest = new FipsNostrPubsubClient({
		node: network.node(peerId),
		localPeerId: peerId,
		peers: () => [hostPeerId],
		allowedKinds: [7368],
	}).start();
	const relayClients = [
		new MemoryRelayClient('wss://relay-one.example', { rejectPublish: true }),
		new MemoryRelayClient('wss://relay-two.example'),
	];
	const bridge = await createWebvmNostrPubsubService({
		node: hostNode,
		localPeerId: hostPeerId,
		peers: () => [peerId],
		filters: FILTERS,
		relayClients,
		authorizePeer: (peer) => peer === peerId,
	});
	await settle(bridge, guest);

	expect(hostNode.services.has(FIPS_NOSTR_PUBSUB_SERVICE_PORT)).toBe(true);
	await expect.poll(() => relayClients.every((client) => client.requests.length === 1)).toBe(true);
	expect(relayClients.map((client) => client.requests[0].filter)).toEqual([FILTERS[0], FILTERS[0]]);

	const received = [];
	relayClients[0].requests[0].handlers.onEvent(event);
	await settle(bridge, guest);
	guest.subscribe(FILTERS, (incoming) => received.push(incoming.id));
	await settle(bridge, guest);
	expect(received).toEqual([event.id]);

	const live = nextEvent(1_700_000_001, 'live relay event');
	relayClients[0].requests[0].handlers.onEvent(live);
	relayClients[1].requests[0].handlers.onEvent(live);
	await settle(bridge, guest);
	expect(received).toEqual([event.id, live.id]);

	const published = nextEvent(1_700_000_002, 'from the local guest');
	await guest.publish(published);
	await settle(bridge, guest);
	expect(relayClients.map((client) => client.published)).toEqual([[published], [published]]);
	expect(bridge.stats.publishBatches).toBe(1);

	await bridge.stop();
	await guest.stop();
	expect(relayClients.every((client) => client.requests[0].closed)).toBe(true);
	expect(hostNode.services.size).toBe(0);
});

test('WebVM requires an explicit relay set, local identity, peers, and filters', async () => {
	const network = new MemoryFipsNetwork();
	const node = network.node(hostPeerId);
	await expect(createWebvmNostrPubsubService({
		node,
		localPeerId: hostPeerId,
		peers: () => [],
		filters: FILTERS,
		relayClients: [],
	})).rejects.toThrow(/At least one shared Nostr relay client/);
	await expect(createWebvmNostrPubsubService({
		node,
		localPeerId: hostPeerId,
		peers: () => [],
		filters: [],
		relayClients: [new MemoryRelayClient('wss://relay.example')],
	})).rejects.toThrow(/explicit bridge filters/);
});

test('WebVM rejects reliable pubsub streams from non-local FIPS peers', async () => {
	const network = new MemoryFipsNetwork();
	const guest = new FipsNostrPubsubClient({
		node: network.node(peerId),
		localPeerId: peerId,
		peers: () => [hostPeerId],
		allowedKinds: [7368],
	}).start();
	const bridge = await createWebvmNostrPubsubService({
		node: network.node(hostPeerId),
		localPeerId: hostPeerId,
		peers: () => [peerId],
		filters: FILTERS,
		relayClients: [new MemoryRelayClient('wss://relay.example')],
		authorizePeer: () => false,
		logger: { warn() {} },
	});
	guest.subscribe(FILTERS, () => undefined);
	await settle(bridge, guest);
	expect(bridge.stats.unauthorizedPeers).toBeGreaterThan(0);

	await bridge.stop();
	await guest.stop();
});

test('port 7368 crosses an authenticated in-memory FIPS session end to end', async () => {
	const hub = new MemoryTransportHub();
	const hostIdentity = await identityFromSecretKey(new Uint8Array(32).fill(11));
	const guestIdentity = await identityFromSecretKey(new Uint8Array(32).fill(13));
	const hostId = toHex(hostIdentity.publicKey);
	const guestId = toHex(guestIdentity.publicKey);
	const host = new FipsNode({
		identity: hostIdentity,
		transports: [new MemoryTransport(hub)],
	});
	const guestNode = new FipsNode({
		identity: guestIdentity,
		transports: [new MemoryTransport(hub)],
	});
	const guest = new FipsNostrPubsubClient({
		node: guestNode,
		localPeerId: guestId,
		peers: () => [hostId],
		allowedKinds: [7368],
	}).start();
	const relayClient = new MemoryRelayClient('wss://relay.example');
	const bridge = await createWebvmNostrPubsubService({
		node: host,
		localPeerId: hostId,
		peers: () => [guestId],
		filters: FILTERS,
		relayClients: [relayClient],
		authorizePeer: (peer) => peer === guestId,
	});
	await host.start();
	await guestNode.start();

	try {
		await guestNode.connect({ transport: 'memory', addr: hostId });
		// Let the authenticated FSP session replace pre-route TCP attempts before
		// the clients refresh their admitted peer set.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		bridge.refreshPeers();
		guest.refreshPeers();
		const received = [];
		guest.subscribe(FILTERS, (incoming) => received.push(incoming.id));
		await settle(bridge, guest);

		relayClient.requests[0].handlers.onEvent(event);
		await settle(bridge, guest);
		expect(received).toEqual([event.id]);

		const published = nextEvent(1_700_000_002, 'authenticated FIPS TCP');
		await guest.publish(published);
		await settle(bridge, guest);
		expect(relayClient.published).toEqual([published]);
	} finally {
		await bridge.stop();
		await guest.stop();
		await guestNode.stop();
		await host.stop();
	}
});
