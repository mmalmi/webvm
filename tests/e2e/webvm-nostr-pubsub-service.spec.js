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
import { FipsTcpEndpoint, MarkerStatus, State } from '@fips/tcp';

import {
	NVPN_STATE_CONTROL_PORT,
	createWebvmNostrPubsubService,
} from '../../src/lib/webvmNostrPubsubService.js';
import {
	event,
	fipsContext,
	MemoryFipsNode,
	MemoryRelayClient,
	MemoryTransport,
	MemoryTransportHub,
	peerId,
} from './webvm-nostr-pubsub-fixtures.js';

async function waitUntil(check, message, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

async function sendTcpRecord(tcp, peer, record) {
	const id = await tcp.connect(peer);
	await waitUntil(async () => {
		await tcp.poll();
		return await tcp.state(id) === State.Established;
	}, 'FIPS-TCP sender did not establish');
	let offset = 0;
	let marker;
	while (offset < record.length) {
		const written = await tcp.writeWithMarker(id, record.subarray(offset));
		offset += written.accepted;
		if (written.accepted > 0) marker = written.marker;
		await tcp.poll();
	}
	await waitUntil(async () => {
		await tcp.poll();
		return await tcp.markerStatus(marker) === MarkerStatus.Acked;
	}, 'FIPS-TCP sender bytes were not acknowledged');
	await tcp.close(id);
}

async function receiveTcpRecord(tcp) {
	const id = await waitUntil(async () => {
		await tcp.poll();
		return await tcp.accept();
	}, 'FIPS-TCP receiver did not accept');
	const chunks = [];
	let length = 0;
	await waitUntil(async () => {
		await tcp.poll();
		const state = await tcp.state(id);
		if (state !== State.Established && state !== State.CloseWait) return false;
		const bytes = await tcp.read(id, 16 * 1024);
		if (bytes.length > 0) {
			chunks.push(bytes);
			length += bytes.length;
			return false;
		}
		return await tcp.isReadClosed(id);
	}, 'FIPS-TCP receiver did not reach EOF');
	await tcp.close(id);
	const record = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		record.set(chunk, offset);
		offset += chunk.length;
	}
	return record;
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
		subscriptionId: 'test-subscription',
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

	await expect(node.receive(fipsContext(adapter.encodeOutbound({
		type: 'req',
		subscriptionId: 'remote-request',
		filters: [{ kinds: [7368] }],
	}), []))).rejects.toThrow(/restricted to local Ethernet guests/);
	expect(relayClient.requests).toHaveLength(0);
	expect(bridge.stats.unauthorizedPeers).toBe(1);

	await bridge.stop();
});

test('WebVM proxies one opaque state-control record over FIPS-TCP with no relay path', async () => {
	const hub = new MemoryTransportHub();
	const hostIdentity = await identityFromSecretKey(new Uint8Array(32).fill(21));
	const guestIdentity = await identityFromSecretKey(new Uint8Array(32).fill(22));
	const adminIdentity = await identityFromSecretKey(new Uint8Array(32).fill(23));
	const decoyIdentity = await identityFromSecretKey(new Uint8Array(32).fill(24));
	const host = new FipsNode({ identity: hostIdentity, transports: [new MemoryTransport(hub)] });
	const guest = new FipsNode({ identity: guestIdentity, transports: [new MemoryTransport(hub)] });
	const admin = new FipsNode({ identity: adminIdentity, transports: [new MemoryTransport(hub)] });
	const guestPeer = toHex(guestIdentity.publicKey);
	const guestParityAlias = `${guestPeer.startsWith('02') ? '03' : '02'}${guestPeer.slice(2)}`;
	const decoyPeer = toHex(decoyIdentity.publicKey);
	const adminPeer = toHex(adminIdentity.publicKey);
	const hostPeer = toHex(hostIdentity.publicKey);
	const observedPeers = [];
	const relayClient = new MemoryRelayClient('wss://relay.example');
	const bridge = createWebvmNostrPubsubService({
		node: host,
		relayClients: [relayClient],
		authorizePeer: (peer) => peer === guestPeer,
		localPeers: () => [decoyPeer, guestPeer, guestParityAlias],
		onStateControlPeer: (peer) => observedPeers.push(peer),
	});
	const adminTcp = new FipsTcpEndpoint(admin, NVPN_STATE_CONTROL_PORT, {}, 100);
	const guestTcp = new FipsTcpEndpoint(guest, NVPN_STATE_CONTROL_PORT, {}, 200);
	await Promise.all([host.start(), guest.start(), admin.start()]);

	try {
		await Promise.all([
			guest.connect({ transport: 'memory', addr: hostPeer }),
			admin.connect({ transport: 'memory', addr: hostPeer }),
		]);
		await guest.sendDatagram({
			dst: hostPeer,
			srcPort: 7368,
			dstPort: 7368,
			payload: new TextEncoder().encode('NVPNCTRL1'),
		});
		const record = new TextEncoder().encode('{"type":"signed-roster","only":1}');
		await sendTcpRecord(adminTcp, hostPeer, record);
		const received = await receiveTcpRecord(guestTcp);

		expect(received).toEqual(record);
		expect(observedPeers).toEqual([adminPeer]);
		expect(bridge.stats.stateControlForwards).toBe(1);
		expect(bridge.stats.stateControlFailures).toBe(0);
		expect(bridge.stats.stateControlReadyHints).toBe(1);
		expect(relayClient.requests).toHaveLength(0);
		expect(relayClient.published).toHaveLength(0);
	} finally {
		await bridge.stop();
		await adminTcp.dispose();
		await guestTcp.dispose();
		await Promise.all([admin.stop(), guest.stop(), host.stop()]);
	}
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
