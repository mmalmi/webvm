import { expect, test } from '@playwright/test';
import {
	FipsNode,
	identityFromSecretKey,
	toHex,
} from '@fips/core';
import { finalizeEvent } from 'nostr-tools/pure';
import {
	FIPS_NOSTR_PUBSUB_SERVICE_PORT,
	FipsPubsubWireAdapter,
} from 'nostr-pubsub';

import { createWebvmNostrPubsubService } from '../../src/lib/webvmNostrPubsubService.js';

const secretKey = new Uint8Array(32).fill(7);
const event = finalizeEvent({
	kind: 7368,
	created_at: 1_700_000_000,
	tags: [['p', '1'.repeat(64)]],
	content: 'opaque encrypted application payload',
}, secretKey);
const peerId = `02${event.pubkey}`;

class MemoryFipsNode {
	services = new Map();
	sessionListeners = new Set();

	registerService(port, handler) {
		this.services.set(port, handler);
		return () => this.services.delete(port);
	}

	on(eventName, listener) {
		if (eventName !== 'session') throw new Error(`unsupported event ${eventName}`);
		this.sessionListeners.add(listener);
		return () => this.sessionListeners.delete(listener);
	}

	receive(context) {
		return this.services.get(context.dstPort)(context);
	}
}

class MemoryRelayClient {
	requests = [];
	published = [];
	closed = false;

	constructor(url, { rejectPublish = false } = {}) {
		this.url = url;
		this.rejectPublish = rejectPublish;
	}

	async subscribe(filter, handlers) {
		const record = { filter, handlers, closed: false };
		this.requests.push(record);
		return () => {
			record.closed = true;
		};
	}

	async publish(publishedEvent) {
		this.published.push(publishedEvent);
		if (this.rejectPublish) throw new Error('relay down');
	}

	close() {
		this.closed = true;
	}
}

class MemoryTransportHub {
	peers = new Map();
}

class MemoryTransport {
	type = 'memory';
	mtu = 65_535;
	context;
	localAddress;

	constructor(hub) {
		this.hub = hub;
	}

	async start(context) {
		this.context = context;
		this.localAddress = toHex(context.localIdentity.publicKey);
		this.hub.peers.set(this.localAddress, this);
	}

	async stop() {
		this.hub.peers.delete(this.localAddress);
		this.context = undefined;
	}

	async connect(address) {
		const remote = this.hub.peers.get(address.addr);
		if (!remote) throw new Error(`missing in-memory FIPS peer ${address.addr}`);
		this.context?.onConnectionState?.({ remoteAddr: address, state: 'connected' });
		remote.context?.onConnectionState?.({
			remoteAddr: { transport: this.type, addr: this.localAddress },
			state: 'connected',
		});
	}

	async send(address, packet) {
		const remote = this.hub.peers.get(address.addr);
		if (!remote?.context) throw new Error(`offline in-memory FIPS peer ${address.addr}`);
		const source = { transport: this.type, addr: this.localAddress };
		queueMicrotask(() => remote.context?.onPacket({
			transportType: this.type,
			remoteAddr: source,
			data: new Uint8Array(packet),
			receivedAtMs: Date.now(),
		}));
	}
}

function fipsContext(payload, replies) {
	return {
		src: peerId,
		srcPort: FIPS_NOSTR_PUBSUB_SERVICE_PORT,
		dstPort: FIPS_NOSTR_PUBSUB_SERVICE_PORT,
		payload,
		async reply(frame) {
			replies.push(frame);
		},
	};
}

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
		subscriptionId: 'join-approval',
		filters: [{ kinds: [7368], '#p': ['1'.repeat(64)], limit: 100 }],
	}), replies));

	expect(node.services.has(FIPS_NOSTR_PUBSUB_SERVICE_PORT)).toBe(true);
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
	expect(reply.subscriptionId).toBe('join-approval');
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
