import { FipsNostrRelayService } from 'nostr-pubsub';

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
	logger = console,
} = {}) {
	if (!node || typeof node.registerService !== 'function') {
		throw new TypeError('WebVM Nostr pubsub service requires a FipsNode');
	}
	if (typeof authorizePeer !== 'function') {
		throw new TypeError('WebVM Nostr pubsub peer authorization must be a function');
	}
	const relayUrls = validateRelayClients(relayClients);
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
		recentSubscriptionFilters: [],
		recentRelayEvents: [],
	};
	const authorizedNode = {
		registerService(port, handler) {
			return node.registerService(port, (context) => {
				if (!authorizePeer(String(context?.src || '').toLowerCase())) {
					stats.unauthorizedPeers += 1;
					throw new Error('WebVM Nostr pubsub is restricted to local Ethernet guests');
				}
				return handler(context);
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

	let stopped = false;
	return {
		service,
		stats,
		relays: relayUrls,
		async stop() {
			if (stopped) return;
			stopped = true;
			await service.stop();
		},
	};
}
