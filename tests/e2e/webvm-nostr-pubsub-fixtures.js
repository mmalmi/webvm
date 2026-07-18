import { toHex } from '@fips/core';
import { finalizeEvent } from 'nostr-tools/pure';

const secretKey = new Uint8Array(32).fill(7);
export const event = finalizeEvent({
	kind: 7368,
	created_at: 1_700_000_000,
	tags: [['p', '1'.repeat(64)]],
	content: 'opaque encrypted application payload',
}, secretKey);
export const peerId = `02${event.pubkey}`;
export const hostPeerId = `03${'4'.repeat(64)}`;

export class MemoryFipsNetwork {
	nodes = new Map();

	node(peer) {
		const node = new MemoryFipsNode(peer, this);
		this.nodes.set(peer, node);
		return node;
	}
}

export class MemoryFipsNode {
	services = new Map();
	peerListeners = new Set();
	sessionListeners = new Set();

	constructor(id, network) {
		this.id = id;
		this.network = network;
	}

	registerService(port, handler) {
		this.services.set(port, handler);
		return () => this.services.delete(port);
	}

	on(eventName, listener) {
		const listeners = eventName === 'peer' ? this.peerListeners : this.sessionListeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	emit(eventName, event) {
		const listeners = eventName === 'peer' ? this.peerListeners : this.sessionListeners;
		for (const listener of listeners) listener(event);
	}

	async sendDatagram(datagram) {
		const target = this.network.nodes.get(datagram.dst);
		if (!target) throw new Error(`unroutable FIPS peer ${datagram.dst}`);
		queueMicrotask(() => void target.receive({
			src: this.id,
			srcPort: datagram.srcPort || 0,
			dstPort: datagram.dstPort,
			payload: new Uint8Array(datagram.payload),
		}).catch(() => undefined));
	}

	async receive(context) {
		const handler = this.services.get(context.dstPort);
		if (!handler) throw new Error(`no FIPS service on ${context.dstPort}`);
		await handler(context);
	}
}

export class MemoryRelayClient {
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

export class MemoryTransportHub {
	peers = new Map();
}

export class MemoryTransport {
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
