import { FipsTcpEndpoint, MarkerStatus, State } from '@fips/tcp';
import { FipsNostrRelayService } from 'nostr-pubsub';

const NOSTR_PUBSUB_PORT = 7368;
export const NVPN_STATE_CONTROL_PORT = 7370;
const MESH_INGRESS_HINT_MAGIC = new TextEncoder().encode('NVPNMESH1');
const STATE_CONTROL_READY_MAGIC = new TextEncoder().encode('NVPNCTRL1');
const STATE_CONTROL_MAX_RECORD_BYTES = 128 * 1024;
const STATE_CONTROL_IO_BYTES = 16 * 1024;
const STATE_CONTROL_DRIVE_MS = 20;
const STATE_CONTROL_TIMEOUT_MS = 15_000;

export function decodeMeshIngressHint(payload) {
	if (!(payload instanceof Uint8Array)
		|| payload.length !== MESH_INGRESS_HINT_MAGIC.length + 32
		|| !MESH_INGRESS_HINT_MAGIC.every((byte, index) => payload[index] === byte)) {
		return null;
	}
	return [...payload.slice(MESH_INGRESS_HINT_MAGIC.length)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function normalizeCarrierPeer(peer) {
	const identity = String(peer || '').toLowerCase();
	return /^(?:02|03)[0-9a-f]{64}$/.test(identity) ? identity : null;
}

function uniqueCarrierPeers(peers) {
	const byXOnlyIdentity = new Map();
	for (const peer of peers) {
		const identity = normalizeCarrierPeer(peer);
		if (identity && !byXOnlyIdentity.has(identity.slice(2))) {
			byXOnlyIdentity.set(identity.slice(2), identity);
		}
	}
	return [...byXOnlyIdentity.values()];
}

function isStateControlReady(payload) {
	return payload instanceof Uint8Array
		&& payload.length === STATE_CONTROL_READY_MAGIC.length
		&& STATE_CONTROL_READY_MAGIC.every((byte, index) => payload[index] === byte);
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

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function joinChunks(chunks, length) {
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}
	return joined;
}

async function readStateControlRecord(tcp, id, isStopped) {
	const deadline = Date.now() + STATE_CONTROL_TIMEOUT_MS;
	const chunks = [];
	let length = 0;
	while (!isStopped()) {
		if (Date.now() >= deadline) throw new Error('FIPS-TCP state-control receive timed out');
		await tcp.poll();
		const state = await tcp.state(id);
		if (state === undefined) throw new Error('FIPS-TCP state-control source closed early');
		if (state === State.Established || state === State.CloseWait) {
			const bytes = await tcp.read(
				id,
				Math.min(STATE_CONTROL_IO_BYTES, STATE_CONTROL_MAX_RECORD_BYTES - length),
			);
			if (bytes.length > 0) {
				chunks.push(bytes);
				length += bytes.length;
				continue;
			}
			if (await tcp.isReadClosed(id)) {
				await tcp.close(id);
				return joinChunks(chunks, length);
			}
			if (length === STATE_CONTROL_MAX_RECORD_BYTES) {
				throw new Error('FIPS-TCP state-control record exceeds 128 KiB');
			}
		}
		await sleep(STATE_CONTROL_DRIVE_MS);
	}
	throw new Error('WebVM state-control proxy stopped');
}

async function waitForLocalControlPeer(localPeers, preferredPeer, isStopped) {
	const deadline = Date.now() + STATE_CONTROL_TIMEOUT_MS;
	while (!isStopped() && Date.now() < deadline) {
		const peers = uniqueCarrierPeers(localPeers());
		const preferred = normalizeCarrierPeer(preferredPeer());
		const selected = preferred && peers.find(
			(peer) => peer.slice(2) === preferred.slice(2),
		);
		if (selected) return selected;
		if (peers.length === 1) return peers[0];
		if (peers.length > 1) {
			throw new Error('WebVM state-control proxy requires exactly one local Ethernet guest');
		}
		await sleep(STATE_CONTROL_DRIVE_MS);
	}
	throw new Error('WebVM local Ethernet guest is unavailable');
}

async function writeStateControlRecord(tcp, peer, record, isStopped) {
	const deadline = Date.now() + STATE_CONTROL_TIMEOUT_MS;
	const id = await tcp.connect(peer);
	let offset = 0;
	let finalMarker;
	try {
		while (!isStopped() && Date.now() < deadline) {
			await tcp.poll();
			const state = await tcp.state(id);
			if (state === undefined) throw new Error('FIPS-TCP state-control destination closed early');
			if ((state === State.Established || state === State.CloseWait) && offset < record.length) {
				const end = Math.min(offset + STATE_CONTROL_IO_BYTES, record.length);
				const { accepted, marker } = await tcp.writeWithMarker(id, record.subarray(offset, end));
				offset += accepted;
				if (accepted > 0 && offset === record.length) finalMarker = marker;
			}
			if (finalMarker) {
				const status = await tcp.markerStatus(finalMarker);
				if (status === MarkerStatus.ConnectionGone) {
					throw new Error('FIPS-TCP state-control destination closed before acknowledgment');
				}
				if (status === MarkerStatus.Acked) {
					await tcp.close(id);
					return;
				}
			}
			await sleep(STATE_CONTROL_DRIVE_MS);
		}
		throw new Error('FIPS-TCP state-control forward timed out');
	} catch (error) {
		await tcp.abort(id).catch(() => {});
		throw error;
	}
}

function randomIsnSeed() {
	const seed = new Uint32Array(1);
	globalThis.crypto.getRandomValues(seed);
	return seed[0];
}

export function createWebvmNostrPubsubService({
	node,
	relayClients,
	limits,
	authorizePeer = () => true,
	localPeers = () => [],
	onStateControlPeer = () => {},
	onMeshIngressHint = () => {},
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
	if (typeof onStateControlPeer !== 'function') {
		throw new TypeError('WebVM state-control peer observer must be a function');
	}
	if (typeof onMeshIngressHint !== 'function') {
		throw new TypeError('WebVM mesh ingress hint observer must be a function');
	}
	const relayUrls = validateRelayClients(relayClients);
	let stopped = false;
	let stateControlLocalPeer = null;
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
		stateControlForwards: 0,
		stateControlFailures: 0,
		stateControlReadyHints: 0,
		lastStateControlPeer: '',
		meshIngressHints: 0,
		recentSubscriptionFilters: [],
		recentRelayEvents: [],
	};
	const authorizedNode = {
		registerService(port, handler) {
			return node.registerService(port, async (context) => {
				const source = String(context?.src || '').toLowerCase();
				if (authorizePeer(source)) {
					if (port === NOSTR_PUBSUB_PORT
						&& context?.dstPort === port
						&& isStateControlReady(context.payload)) {
						stateControlLocalPeer = normalizeCarrierPeer(source);
						stats.stateControlReadyHints += 1;
						return;
					}
					const meshIngress = port === NOSTR_PUBSUB_PORT && context?.dstPort === port
						? decodeMeshIngressHint(context.payload)
						: null;
					if (meshIngress) {
						stats.meshIngressHints += 1;
						onMeshIngressHint(meshIngress);
						return;
					}
					return handler(context);
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
	const stateControl = new FipsTcpEndpoint(node, NVPN_STATE_CONTROL_PORT, {
		receiveBuffer: 0xffff,
		sendBuffer: 0xffff,
		maxConnections: 64,
		maxConnectionsPerPeer: 8,
	}, randomIsnSeed());
	service.start();

	const proxyTask = (async () => {
		while (!stopped) {
			try {
				await stateControl.poll();
				const upstream = await stateControl.accept();
				if (upstream === undefined) {
					await sleep(STATE_CONTROL_DRIVE_MS);
					continue;
				}
				try {
					const upstreamPeer = await stateControl.peer(upstream);
					if (!normalizeCarrierPeer(upstreamPeer)) {
						throw new Error('WebVM state-control source has an invalid FIPS identity');
					}
					const record = await readStateControlRecord(stateControl, upstream, () => stopped);
					const downstreamPeer = await waitForLocalControlPeer(
						localPeers,
						() => stateControlLocalPeer,
						() => stopped,
					);
					onStateControlPeer(upstreamPeer);
					await writeStateControlRecord(stateControl, downstreamPeer, record, () => stopped);
					stats.stateControlForwards += 1;
					stats.lastStateControlPeer = upstreamPeer;
				} catch (error) {
					await stateControl.abort(upstream).catch(() => {});
					throw error;
				}
			} catch (error) {
				if (stopped) break;
				stats.stateControlFailures += 1;
				stats.lastServiceError = classifyServiceError(error);
				stats.lastServiceErrorMessage = safeServiceErrorMessage(error);
				logger.warn?.('WebVM FIPS-TCP state-control proxy error', error);
				await sleep(STATE_CONTROL_DRIVE_MS);
			}
		}
	})();

	return {
		service,
		stats,
		relays: relayUrls,
		async stop() {
			if (stopped) return;
			stopped = true;
			await proxyTask;
			await stateControl.dispose();
			await service.stop();
		},
	};
}
