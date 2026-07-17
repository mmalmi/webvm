import { toHex } from '@fips/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { FIPS_NOSTR_PUBSUB_SERVICE_PORT } from 'nostr-pubsub';

const secretKey = new Uint8Array(32).fill(7);
export const event = finalizeEvent({
	kind: 7368,
	created_at: 1_700_000_000,
	tags: [['p', '1'.repeat(64)]],
	content: 'opaque encrypted application payload',
}, secretKey);
export const peerId = `02${event.pubkey}`;

export class MemoryFipsNode {
	services = new Map();
	sessionListeners = new Set();
	sent = [];
	activeSends = 0;
	maxConcurrentSends = 0;

	constructor(sendDelayMs = 0) {
		this.sendDelayMs = sendDelayMs;
	}

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

	async sendDatagram(datagram) {
		this.activeSends += 1;
		this.maxConcurrentSends = Math.max(this.maxConcurrentSends, this.activeSends);
		if (this.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
		this.sent.push(datagram);
		this.activeSends -= 1;
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

export function fipsContext(payload, replies) {
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
