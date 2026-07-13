import { FipsNostrRelayService, FipsPubsubWireCodec } from 'nostr-pubsub';

const DIRECT_JOIN_APPROVAL_PORT = 7368;
const DIRECT_JOIN_APPROVAL_ROUTE_MAGIC = new TextEncoder().encode('NVPNFWD1');
const DIRECT_JOIN_APPROVAL_ROUTE_REGISTRATION = new TextEncoder().encode('NVPNPAIR1');
const DIRECT_JOIN_APPROVAL_ACK_MAGIC = new TextEncoder().encode('NVPNACK1');
const DIRECT_JOIN_APPROVAL_ROUTE_HEADER_BYTES = DIRECT_JOIN_APPROVAL_ROUTE_MAGIC.length + 32;
const DIRECT_JOIN_APPROVAL_REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PENDING_DIRECT_APPROVAL_FRAMES = 4;
const MAX_PENDING_DIRECT_APPROVAL_RECIPIENTS = 32;
const directApprovalCodec = new FipsPubsubWireCodec();

function decodeRoutedJoinApproval(payload) {
	try {
		if (!(payload instanceof Uint8Array)
			|| payload.length <= DIRECT_JOIN_APPROVAL_ROUTE_HEADER_BYTES
			|| !DIRECT_JOIN_APPROVAL_ROUTE_MAGIC.every((byte, index) => payload[index] === byte)) {
			return null;
		}
		const recipient = payload.slice(
			DIRECT_JOIN_APPROVAL_ROUTE_MAGIC.length,
			DIRECT_JOIN_APPROVAL_ROUTE_HEADER_BYTES,
		);
		const frame = payload.slice(DIRECT_JOIN_APPROVAL_ROUTE_HEADER_BYTES);
		const message = directApprovalCodec.decodeFrame(frame);
		if (message.type !== 'event' || !message.subscriptionId?.startsWith('nvpn-join-')) return null;
		return {
			recipient: [...recipient].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
			frame,
		};
	} catch {
		return null;
	}
}

function isApprovalRouteRegistration(payload) {
	return payload instanceof Uint8Array
		&& payload.length === DIRECT_JOIN_APPROVAL_ROUTE_REGISTRATION.length
		&& DIRECT_JOIN_APPROVAL_ROUTE_REGISTRATION.every((byte, index) => payload[index] === byte);
}

function isApprovalAppliedAck(payload) {
	return payload instanceof Uint8Array
		&& payload.length > DIRECT_JOIN_APPROVAL_ACK_MAGIC.length
		&& DIRECT_JOIN_APPROVAL_ACK_MAGIC.every((byte, index) => payload[index] === byte);
}

function xOnlyPeerIdentity(peer) {
	const identity = String(peer || '').toLowerCase();
	return /^(?:02|03)[0-9a-f]{64}$/.test(identity) ? identity.slice(2) : null;
}

function validateRelayClients(relayClients) {
	if (!Array.isArray(relayClients) || relayClients.length === 0) {
		throw new TypeError('At least one shared Nostr relay client is required');
	}
	const urls = [];
	for (const client of relayClients) {
		if (!client || typeof client.subscribe !== 'function' || typeof client.publish !== 'function') {
			throw new TypeError('Invalid shared Nostr relay client');
		}
		const url = new URL(client.url);
		if (url.protocol !== 'wss:') {
			throw new TypeError(`Nostr relay must use secure WebSocket transport: ${client.url}`);
		}
		if (url.username || url.password) {
			throw new TypeError('Nostr relay URL must not contain credentials');
		}
		if (urls.includes(url.href)) {
			throw new TypeError(`Duplicate shared Nostr relay client: ${url.href}`);
		}
		urls.push(url.href);
	}
	return Object.freeze(urls);
}

function createRelayTransport(relayClients, stats) {
	return {
		subscribe(filters, handlers) {
			stats.subscriptionBatches += 1;
			stats.recentSubscriptionFilters.push(structuredClone(filters));
			if (stats.recentSubscriptionFilters.length > 8) stats.recentSubscriptionFilters.shift();
			let closed = false;
			const cleanups = [];
			const subscriptions = relayClients.flatMap((client) =>
				filters.map(async (filter) => {
					const cleanup = await client.subscribe(filter, {
						onEvent(event) {
							stats.relayEvents += 1;
							stats.recentRelayEvents.push({ id: event.id, kind: event.kind });
							if (stats.recentRelayEvents.length > 16) stats.recentRelayEvents.shift();
							handlers.onEvent(event);
						},
					});
					stats.relaySubscriptions += 1;
					if (closed) cleanup();
					else cleanups.push(cleanup);
				}),
			);
			void Promise.allSettled(subscriptions).then((results) => {
				stats.relaySubscriptionFailures += results.filter(
					(result) => result.status === 'rejected',
				).length;
				if (closed || results.some((result) => result.status === 'fulfilled')) return;
				handlers.onClose?.(results.map((result) => String(result.reason)));
			});
			return {
				close() {
					closed = true;
					for (const cleanup of cleanups.splice(0)) cleanup();
				},
			};
		},
		async publish(event) {
			stats.publishBatches += 1;
			const results = await Promise.allSettled(
				relayClients.map((client) => client.publish(event)),
			);
			if (results.every((result) => result.status === 'rejected')) {
				throw new AggregateError(
					results.map((result) => result.reason),
					'All configured Nostr relays rejected the event',
				);
			}
		},
	};
}

function classifyServiceError(error) {
	const message = error instanceof Error ? error.message : String(error || '');
	if (message.includes('no route')) return 'no-route';
	if (message.includes('exceeds MTU') || message.includes('MtuExceeded')) return 'mtu-exceeded';
	if (message.includes('handshake timeout')) return 'handshake-timeout';
	if (message.includes('before') && message.includes('handshake')) return 'handshake-state';
	if (message.includes('reply queue')) return 'reply-backpressure';
	if (message.includes('decrypt')) return 'decrypt-failed';
	if (message.includes('signature')) return 'signature-failed';
	return 'other';
}

function safeServiceErrorMessage(error) {
	const message = error instanceof Error ? error.message : String(error || '');
	return message
		.replace(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/gi, 'npub1[redacted]')
		.replace(/\b(?:02|03)?[0-9a-f]{64}\b/gi, '[redacted-key]')
		.slice(0, 240);
}

export function createWebvmNostrPubsubService({
	node,
	relayClients,
	limits,
	authorizePeer = () => true,
	localPeers = () => [],
	onDirectApprovalPeer = () => {},
	directApprovalRetryMs = 500,
	logger = console,
} = {}) {
	if (!node || typeof node.registerService !== 'function') {
		throw new TypeError('WebVM Nostr pubsub service requires a FipsNode');
	}
	if (typeof authorizePeer !== 'function') {
		throw new TypeError('WebVM Nostr pubsub peer authorization must be a function');
	}
	if (typeof localPeers !== 'function') {
		throw new TypeError('WebVM local FIPS peers must be provided by a function');
	}
	if (typeof onDirectApprovalPeer !== 'function') {
		throw new TypeError('WebVM direct approval peer observer must be a function');
	}
	if (!Number.isSafeInteger(directApprovalRetryMs) || directApprovalRetryMs <= 0) {
		throw new TypeError('WebVM direct approval retry interval must be a positive integer');
	}
	const relayUrls = validateRelayClients(relayClients);
	const pendingDirectApprovals = new Map();
	let directApprovalSendTail = Promise.resolve();
	let stopped = false;
	const stats = {
		subscriptionBatches: 0,
		relaySubscriptions: 0,
		relaySubscriptionFailures: 0,
		relayEvents: 0,
		publishBatches: 0,
		serviceErrors: 0,
		serviceErrorOperations: {},
		lastServiceError: '',
		lastServiceErrorMessage: '',
		unauthorizedPeers: 0,
		directApprovalForwards: 0,
		directApprovalReplays: 0,
		directApprovalAcks: 0,
		directApprovalAckReplays: 0,
		directRouteRegistrations: 0,
		lastDirectRoutePeer: '',
		recentSubscriptionFilters: [],
		recentRelayEvents: [],
	};
	const forgetDirectApproval = (recipient) => {
		const pending = pendingDirectApprovals.get(recipient);
		if (pending?.retryTimer) clearTimeout(pending.retryTimer);
		pendingDirectApprovals.delete(recipient);
	};
	const sendDirectApprovalDatagram = (datagram) => {
		const sent = directApprovalSendTail.then(() => node.sendDatagram(datagram));
		directApprovalSendTail = sent.catch(() => {});
		return sent;
	};
	const rememberDirectApproval = (approval, upstreamPeer, downstreamPeer) => {
		const now = Date.now();
		for (const [recipient, pending] of pendingDirectApprovals) {
			if (pending.expiresAt <= now) forgetDirectApproval(recipient);
		}
		let pending = pendingDirectApprovals.get(approval.recipient);
		if (!pending) {
			pending = {
				frames: [],
				upstreamPeers: new Set(),
				ack: null,
				downstreamPeer,
				retryTimer: null,
				expiresAt: now + DIRECT_JOIN_APPROVAL_REPLAY_TTL_MS,
			};
			pendingDirectApprovals.set(approval.recipient, pending);
		}
		pending.upstreamPeers.add(upstreamPeer);
		pending.downstreamPeer = downstreamPeer;
		pending.expiresAt = now + DIRECT_JOIN_APPROVAL_REPLAY_TTL_MS;
		if (!pending.frames.some((frame) => frame.length === approval.frame.length
			&& frame.every((byte, index) => byte === approval.frame[index]))) {
			pending.frames.push(approval.frame.slice());
			if (pending.frames.length > MAX_PENDING_DIRECT_APPROVAL_FRAMES) {
				pending.frames.shift();
			}
		}
		while (pendingDirectApprovals.size > MAX_PENDING_DIRECT_APPROVAL_RECIPIENTS) {
			forgetDirectApproval(pendingDirectApprovals.keys().next().value);
		}
		return pending;
	};
	const replayDirectApproval = async (peer) => {
		const recipient = xOnlyPeerIdentity(peer);
		if (!recipient) return;
		const pending = pendingDirectApprovals.get(recipient);
		if (!pending) return;
		if (pending.expiresAt <= Date.now()) {
			forgetDirectApproval(recipient);
			return;
		}
		if (pending.ack) return;
		for (const frame of pending.frames) {
			await sendDirectApprovalDatagram({
				dst: peer,
				srcPort: DIRECT_JOIN_APPROVAL_PORT,
				dstPort: DIRECT_JOIN_APPROVAL_PORT,
				payload: frame,
			});
			stats.directApprovalReplays += 1;
		}
	};
	const scheduleDirectApprovalReplay = (recipient) => {
		const pending = pendingDirectApprovals.get(recipient);
		if (stopped || !pending || pending.ack || pending.retryTimer) return;
		pending.retryTimer = setTimeout(async () => {
			pending.retryTimer = null;
			if (stopped || pendingDirectApprovals.get(recipient) !== pending || pending.ack) return;
			try {
				await replayDirectApproval(pending.downstreamPeer);
			} catch (error) {
				stats.serviceErrors += 1;
				stats.serviceErrorOperations['direct-approval-replay'] =
					(stats.serviceErrorOperations['direct-approval-replay'] || 0) + 1;
				stats.lastServiceError = classifyServiceError(error);
				stats.lastServiceErrorMessage = safeServiceErrorMessage(error);
				logger.warn?.('WebVM direct approval replay failed', error);
			}
			scheduleDirectApprovalReplay(recipient);
		}, directApprovalRetryMs);
	};
	const forwardApprovalAck = async (peer, payload) => {
		const recipient = xOnlyPeerIdentity(peer);
		if (!recipient) return false;
		const pending = pendingDirectApprovals.get(recipient);
		if (!pending || pending.expiresAt <= Date.now()) {
			forgetDirectApproval(recipient);
			return false;
		}
		pending.ack = payload.slice();
		if (pending.retryTimer) clearTimeout(pending.retryTimer);
		pending.retryTimer = null;
		pending.expiresAt = Date.now() + DIRECT_JOIN_APPROVAL_REPLAY_TTL_MS;
		for (const upstreamPeer of pending.upstreamPeers) {
			await sendDirectApprovalDatagram({
				dst: upstreamPeer,
				srcPort: DIRECT_JOIN_APPROVAL_PORT,
				dstPort: DIRECT_JOIN_APPROVAL_PORT,
				payload: pending.ack.slice(),
			});
			stats.directApprovalAcks += 1;
		}
		return true;
	};
	const authorizedNode = {
		registerService(port, handler) {
			return node.registerService(port, async (context) => {
				if (authorizePeer(String(context?.src || '').toLowerCase())) {
					if (port === DIRECT_JOIN_APPROVAL_PORT
						&& context?.dstPort === port
						&& isApprovalAppliedAck(context.payload)
						&& await forwardApprovalAck(context.src, context.payload)) {
						return;
					}
					if (port === DIRECT_JOIN_APPROVAL_PORT
						&& context?.dstPort === port
						&& isApprovalRouteRegistration(context.payload)) {
						stats.directRouteRegistrations += 1;
						stats.lastDirectRoutePeer = String(context.src || '').toLowerCase();
						const recipient = xOnlyPeerIdentity(context.src);
						const pending = recipient && pendingDirectApprovals.get(recipient);
						if (pending) {
							pending.downstreamPeer = context.src;
							scheduleDirectApprovalReplay(recipient);
						}
						return;
					}
					return handler(context);
				}
				const approval = port === DIRECT_JOIN_APPROVAL_PORT && context?.dstPort === port
					? decodeRoutedJoinApproval(context.payload)
					: null;
				if (approval) {
					const dst = [...new Set(localPeers())].find(
						(peer) => xOnlyPeerIdentity(peer) === approval.recipient,
					);
					if (!dst) throw new Error('WebVM local FIPS approval recipient is unavailable');
					const pending = rememberDirectApproval(approval, context.src, dst);
					if (pending.ack) {
						await sendDirectApprovalDatagram({
							dst: context.src,
							srcPort: port,
							dstPort: port,
							payload: pending.ack.slice(),
						});
						stats.directApprovalAckReplays += 1;
						return;
					}
					await sendDirectApprovalDatagram({
						dst,
						srcPort: port,
						dstPort: port,
						payload: approval.frame,
					});
					onDirectApprovalPeer(context.src);
					stats.directApprovalForwards += 1;
					scheduleDirectApprovalReplay(approval.recipient);
					return;
				}
				stats.unauthorizedPeers += 1;
				throw new Error('WebVM Nostr pubsub is restricted to local Ethernet guests');
			});
		},
		on(event, listener) {
			return node.on?.(event, listener);
		},
	};
	const service = new FipsNostrRelayService({
		node: authorizedNode,
		relay: createRelayTransport(relayClients, stats),
		limits,
		onError(error, context) {
			stats.serviceErrors += 1;
			const operation = String(context?.operation || 'unknown');
			stats.serviceErrorOperations[operation] =
				(stats.serviceErrorOperations[operation] || 0) + 1;
			stats.lastServiceError = classifyServiceError(error);
			stats.lastServiceErrorMessage = safeServiceErrorMessage(error);
			logger.warn?.('WebVM Nostr pubsub relay error', context, error);
		},
	});
	service.start();

	return {
		service,
		stats,
		relays: relayUrls,
		async stop() {
			if (stopped) return;
			stopped = true;
			for (const recipient of pendingDirectApprovals.keys()) forgetDirectApproval(recipient);
			pendingDirectApprovals.clear();
			await service.stop();
		},
	};
}
