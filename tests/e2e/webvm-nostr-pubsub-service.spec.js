import { expect, test } from '@playwright/test';
import {
	FipsNode,
	identityFromSecretKey,
	toHex,
} from '@fips/core';
import {
	FIPS_NOSTR_PUBSUB_SERVICE_PORT,
	FipsPubsubWireAdapter,
} from 'nostr-pubsub';
import { createWebvmNostrPubsubService } from '../../src/lib/webvmNostrPubsubService.js';
import {
	event,
	fipsContext,
	MemoryFipsNode,
	MemoryRelayClient,
	MemoryTransport,
	MemoryTransportHub,
	peerId,
} from './webvm-nostr-pubsub-fixtures.js';

test('WebVM bridges only configured relays through the generic FIPS service', async () => {
	const node = new MemoryFipsNode();
	const relayClients = [
		new MemoryRelayClient('wss://relay-one.example', { rejectPublish: true }),
		new MemoryRelayClient('wss://relay-two.example'),
	];
	const adapter = new FipsPubsubWireAdapter();
	const bridge = createWebvmNostrPubsubService({
		node,
		relayClients,
		authorizePeer: (peer) => peer === peerId,
	});
	const replies = [];

	await node.receive(fipsContext(adapter.encodeOutbound({
		type: 'req',
		subscriptionId: 'test-subscription',
		filters: [{ kinds: [7368], '#p': ['1'.repeat(64)], limit: 100 }],
	}), replies));

	expect(node.services.has(FIPS_NOSTR_PUBSUB_SERVICE_PORT)).toBe(true);
	expect([...node.services.keys()]).toEqual([FIPS_NOSTR_PUBSUB_SERVICE_PORT]);
	expect(Object.keys(bridge.stats).some((key) => /approval|stateControl/u.test(key))).toBe(false);
	await expect.poll(() => relayClients.every((client) => client.requests.length === 1)).toBe(true);
	expect(relayClients.map((client) => client.requests[0].filter)).toEqual([
		{ kinds: [7368], '#p': ['1'.repeat(64)], limit: 8 },
		{ kinds: [7368], '#p': ['1'.repeat(64)], limit: 8 },
	]);

	relayClients[0].requests[0].handlers.onEvent(event);
	await expect.poll(() => replies.length).toBe(1);
	const reply = adapter.codec.decodeFrame(replies[0]);
	expect(reply.type).toBe('event');
	if (reply.type !== 'event') throw new Error('expected EVENT');
	expect(reply.subscriptionId).toBe('test-subscription');
	expect(reply.event.id).toBe(event.id);

	await node.receive(fipsContext(adapter.encodeOutbound({ type: 'event', event }), replies));
	expect(relayClients.map((client) => client.published)).toEqual([[event], [event]]);

	await bridge.stop();
	expect(relayClients.every((client) => client.requests[0].closed)).toBe(true);
	expect(relayClients.every((client) => !client.closed)).toBe(true);
	expect(node.services.size).toBe(0);
});

test('WebVM requires an explicit relay set and does not add another path', () => {
	const node = new MemoryFipsNode();
	expect(() => createWebvmNostrPubsubService({ node, relayClients: [] }))
		.toThrow(/At least one shared Nostr relay client/);
});

test('WebVM rejects pubsub access from non-local FIPS peers', async () => {
	const node = new MemoryFipsNode();
	const relayClient = new MemoryRelayClient('wss://relay.example');
	const bridge = createWebvmNostrPubsubService({
		node,
		relayClients: [relayClient],
		authorizePeer: () => false,
	});
	const adapter = new FipsPubsubWireAdapter();

	expect(() => node.receive(fipsContext(adapter.encodeOutbound({
		type: 'req',
		subscriptionId: 'remote-request',
		filters: [{ kinds: [7368] }],
	}), []))).toThrow(/restricted to local Ethernet guests/);
	expect(relayClient.requests).toHaveLength(0);
	expect(bridge.stats.unauthorizedPeers).toBe(1);

	await bridge.stop();
});

test('port 7368 crosses an authenticated in-memory FIPS session end to end', async () => {
	const hub = new MemoryTransportHub();
	const hostIdentity = await identityFromSecretKey(new Uint8Array(32).fill(11));
	const guestIdentity = await identityFromSecretKey(new Uint8Array(32).fill(13));
	const host = new FipsNode({
		identity: hostIdentity,
		transports: [new MemoryTransport(hub)],
	});
	const guest = new FipsNode({
		identity: guestIdentity,
		transports: [new MemoryTransport(hub)],
	});
	const relayClient = new MemoryRelayClient('wss://relay.example');
	const bridge = createWebvmNostrPubsubService({
		node: host,
		relayClients: [relayClient],
		authorizePeer: (peer) => peer === toHex(guestIdentity.publicKey),
	});
	const adapter = new FipsPubsubWireAdapter();
	await host.start();
	await guest.start();

	try {
		await guest.connect({ transport: 'memory', addr: toHex(hostIdentity.publicKey) });
		await guest.sendDatagram({
			dst: toHex(hostIdentity.publicKey),
			srcPort: FIPS_NOSTR_PUBSUB_SERVICE_PORT,
			dstPort: FIPS_NOSTR_PUBSUB_SERVICE_PORT,
			payload: adapter.encodeOutbound({
				type: 'req',
				subscriptionId: 'authenticated-request',
				filters: [{ kinds: [7368], '#p': ['1'.repeat(64)] }],
			}),
		});
		await expect.poll(() => relayClient.requests.length).toBe(1);

		const response = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('FIPS pubsub reply timeout')), 5_000);
			const remove = guest.on('datagram', (message) => {
				if (message.dstPort !== FIPS_NOSTR_PUBSUB_SERVICE_PORT) return;
				clearTimeout(timer);
				remove();
				resolve(message.payload);
			});
		});
		relayClient.requests[0].handlers.onEvent(event);
		const reply = adapter.codec.decodeFrame(await response);
		expect(reply.type).toBe('event');
		if (reply.type !== 'event') throw new Error('expected EVENT');
		expect(reply.subscriptionId).toBe('authenticated-request');

		await guest.sendDatagram({
			dst: toHex(hostIdentity.publicKey),
			srcPort: FIPS_NOSTR_PUBSUB_SERVICE_PORT,
			dstPort: FIPS_NOSTR_PUBSUB_SERVICE_PORT,
			payload: adapter.encodeOutbound({ type: 'event', event }),
		});
		await expect.poll(() => relayClient.published.length).toBe(1);
		expect(relayClient.published[0].id).toBe(event.id);
	} finally {
		await bridge.stop();
		await guest.stop();
		await host.stop();
	}
});
