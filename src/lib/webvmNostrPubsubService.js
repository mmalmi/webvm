import {
	FipsNostrPubsubClient,
	FipsNostrPubsubEventSource,
	NostrPubsubRouter,
	NostrRelayEventSource,
	allowWithPriority,
	fipsPeerDefaultRoute,
	relayRoute,
} from 'nostr-pubsub';

const COMPRESSED_FIPS_KEY = /^(?:02|03)[0-9a-f]{64}$/u;
const allowBridgeRoutes = {
	checkEvent: () => allowWithPriority(0),
	checkSource: () => allowWithPriority(0),
};

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

function validateFilters(filters) {
	if (!Array.isArray(filters) || filters.length === 0) {
		throw new TypeError('WebVM Nostr pubsub requires explicit bridge filters');
	}
	for (const filter of filters) {
		if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
			throw new TypeError('Invalid WebVM Nostr pubsub bridge filter');
		}
	}
	return structuredClone(filters);
}

function configuredKinds(filters) {
	if (filters.some((filter) => !Array.isArray(filter.kinds) || filter.kinds.length === 0)) {
		return undefined;
	}
	return [...new Set(filters.flatMap((filter) => filter.kinds))];
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
	if (message.includes('no route') || message.includes('unroutable')) return 'no-route';
	if (message.includes('handshake timeout')) return 'handshake-timeout';
	if (message.includes('before') && message.includes('handshake')) return 'handshake-state';
	if (message.includes('queue')) return 'backpressure';
	if (message.includes('decrypt')) return 'decrypt-failed';
	if (message.includes('signature')) return 'signature-failed';
	return 'other';
}

function safeServiceErrorMessage(error) {
	const message = error instanceof Error ? error.message : String(error || '');
	return message
		.replace(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/giu, 'npub1[redacted]')
		.replace(/\b(?:02|03)?[0-9a-f]{64}\b/giu, '[redacted-key]')
		.slice(0, 240);
}

/**
 * Routes one explicit Nostr subscription set between traditional relays and
 * authenticated local FIPS peers. The shared router globally deduplicates
 * relay/FIPS echoes while the FIPS adapter uses reliable TCP INV/WANT records.
 */
export async function createWebvmNostrPubsubService({
	node,
	localPeerId,
	peers,
	filters,
	relayClients,
	limits,
	authorizePeer = () => true,
	logger = console,
} = {}) {
	if (!node || typeof node.registerService !== 'function' || typeof node.sendDatagram !== 'function') {
		throw new TypeError('WebVM Nostr pubsub service requires a FipsNode');
	}
	if (!COMPRESSED_FIPS_KEY.test(String(localPeerId || '').toLowerCase())) {
		throw new TypeError('WebVM Nostr pubsub requires a compressed local FIPS identity');
	}
	if (typeof peers !== 'function') {
		throw new TypeError('WebVM Nostr pubsub requires an admitted peer source');
	}
	if (typeof authorizePeer !== 'function') {
		throw new TypeError('WebVM Nostr pubsub peer authorization must be a function');
	}
	const bridgeFilters = validateFilters(filters);
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
	const admittedPeers = () => [...new Set(peers()
		.map((peer) => String(peer).toLowerCase())
		.filter((peer) => authorizePeer(peer)))];
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
		sendDatagram(datagram) {
			if (!authorizePeer(String(datagram?.dst || '').toLowerCase())) {
				throw new Error('WebVM Nostr pubsub cannot send to a non-local FIPS peer');
			}
			return node.sendDatagram(datagram);
		},
		on(event, listener) {
			return node.on?.(event, listener);
		},
	};
	const reportError = (error, context) => {
		stats.serviceErrors += 1;
		const operation = String(context?.operation || 'bridge');
		stats.serviceErrorOperations[operation] =
			(stats.serviceErrorOperations[operation] || 0) + 1;
		stats.lastServiceError = classifyServiceError(error);
		stats.lastServiceErrorMessage = safeServiceErrorMessage(error);
		logger.warn?.('WebVM Nostr pubsub router error', context, error);
	};
	const client = new FipsNostrPubsubClient({
		node: authorizedNode,
		localPeerId: localPeerId.toLowerCase(),
		peers: admittedPeers,
		allowedKinds: configuredKinds(bridgeFilters),
		limits,
		onError: reportError,
	}).start();
	const fips = new FipsNostrPubsubEventSource(client);
	const relay = new NostrRelayEventSource(
		`webvm:${relayUrls.join(',')}`,
		createRelayTransport(relayClients, stats),
	);
	const fipsRoute = fipsPeerDefaultRoute('webvm-local-ethernet');
	const relayRouteEntry = relayRoute(`webvm:${relayUrls.join(',')}`);
	const router = new NostrPubsubRouter({
		policy: allowBridgeRoutes,
		liveSources: [
			{ route: fipsRoute, subscriber: fips },
			{ route: relayRouteEntry, subscriber: relay },
		],
	});
	const pending = new Set();
	const forward = (promise, context) => {
		const tracked = Promise.resolve(promise)
			.catch((error) => reportError(error, context))
			.finally(() => pending.delete(tracked));
		pending.add(tracked);
	};
	let subscription;
	try {
		subscription = await router.subscribeWithOptions(bridgeFilters, (incoming) => {
			if (incoming.route.id === relayRouteEntry.id) {
				forward(fips.publish(incoming.event, incoming.source), { operation: 'relay-to-fips' });
				return;
			}
			forward(relay.publish(incoming.event, incoming.source), { operation: 'fips-to-relay' });
		});
	} catch (error) {
		await client.stop();
		throw error;
	}

	let stopped = false;
	return {
		client,
		router,
		stats,
		relays: relayUrls,
		refreshPeers() {
			client.refreshPeers();
		},
		async idle() {
			await client.idle();
			while (pending.size > 0) await Promise.allSettled([...pending]);
			await client.idle();
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			subscription.close();
			while (pending.size > 0) await Promise.allSettled([...pending]);
			await client.stop();
		},
	};
}
