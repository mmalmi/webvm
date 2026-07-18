import { noopLogger } from '@fips/core';

function unavailable(type) {
	return new Error(`${type} carrier is unavailable`);
}

/**
 * Keeps one unavailable carrier from preventing independent FIPS transports
 * from starting. A page reload retries the carrier with a fresh transport.
 */
export function createOptionalFipsTransport(transport, {
	logger = noopLogger,
	onUnavailable = () => {},
} = {}) {
	let active = false;
	const optional = {
		type: transport.type,
		mtu: transport.mtu,
		async start(context) {
			try {
				await transport.start(context);
				active = true;
			} catch (error) {
				active = false;
				await transport.stop().catch(() => {});
				logger.warn?.(`Optional FIPS ${transport.type} carrier unavailable`, error);
				onUnavailable({ type: transport.type, error });
			}
		},
		async stop() {
			active = false;
			await transport.stop();
		},
		async connect(address) {
			if (!active) throw unavailable(transport.type);
			return transport.connect(address);
		},
		async send(address, packet) {
			if (!active) throw unavailable(transport.type);
			return transport.send(address, packet);
		},
	};

	if (transport.close) {
		optional.close = async (address) => {
			if (!active) return;
			await transport.close(address);
		};
	}
	if (transport.discover) {
		optional.discover = async function* discover() {
			if (!active) return;
			yield* transport.discover();
		};
	}
	if (transport.resolve) {
		optional.resolve = async (nodeAddr, signal) => {
			if (!active) return undefined;
			return transport.resolve(nodeAddr, signal);
		};
	}
	if (transport.handlePeerRestart) {
		optional.handlePeerRestart = async (remotePubkeyHex) => {
			if (!active) return;
			await transport.handlePeerRestart(remotePubkeyHex);
		};
	}
	if (transport.handleLinkNegotiation) {
		optional.handleLinkNegotiation = async (remotePubkeyHex, message) => {
			if (!active) return;
			await transport.handleLinkNegotiation(remotePubkeyHex, message);
		};
	}
	if (transport.companionTransports) {
		optional.companionTransports = () => transport.companionTransports().map((companion) => (
			createOptionalFipsTransport(companion, { logger, onUnavailable })
		));
	}

	return optional;
}
