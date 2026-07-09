const REQUIRED_PACKET_BACKEND_METHODS = Object.freeze([
	'onTxPacket(handler: (packet: Uint8Array) => void): () => void',
	'injectRxPacket(packet: Uint8Array): Promise<void> | void',
	'mtu: number',
]);

const CHEERPX_CONTROL_PLANE_FIELDS = Object.freeze([
	'authKey',
	'controlUrl',
	'loginUrlCb',
	'stateUpdateCb',
	'netmapUpdateCb',
]);

const CHEERPX_PACKET_CAPABILITY_MARKERS = Object.freeze({
	outboundPacketCallback: Object.freeze([
		'onTxPacket',
		'onPacket',
		'onGuestPacket',
		'onTransmitPacket',
	]),
	inboundPacketInjection: Object.freeze([
		'injectRxPacket',
		'injectPacket',
		'writePacket',
		'deliverPacket',
	]),
	linkMetadata: Object.freeze([
		'mtu',
		'linkState',
		'macAddress',
		'setLinkState',
	]),
});

const CHEERPX_PACKET_BACKEND_UNAVAILABLE = Object.freeze({
	state: 'packet-backend-unavailable',
	canRouteVmTraffic: false,
	connected: false,
	summary: 'Packet backend unavailable',
	reason: 'CheerpX exposes Tailscale-style control hooks, not raw VM packet ingress/egress.',
	requiredMethods: REQUIRED_PACKET_BACKEND_METHODS,
});

export class NostrVpnPacketBackendUnavailableError extends Error {
	constructor(report) {
		super(report.reason);
		this.name = 'NostrVpnPacketBackendUnavailableError';
		this.code = 'CHEERPX_RAW_PACKET_NIC_UNAVAILABLE';
		this.report = report;
	}
}

function extractNetworkInterfaceBlock(typeDeclarations) {
	const match = String(typeDeclarations || '').match(/interface\s+NetworkInterface\s*{([\s\S]*?)\n}/);
	return match ? match[1] : '';
}

function hasMarker(source, markers) {
	return markers.some((marker) => new RegExp(`\\b${marker}\\b`).test(source));
}

export function validatePacketBackend(backend) {
	if (!backend || typeof backend !== 'object') {
		throw new TypeError('Nostr VPN packet backend is missing');
	}
	if (typeof backend.onTxPacket !== 'function') {
		throw new TypeError('Nostr VPN packet backend missing onTxPacket(handler)');
	}
	if (typeof backend.injectRxPacket !== 'function') {
		throw new TypeError('Nostr VPN packet backend missing injectRxPacket(packet)');
	}
	if (!Number.isFinite(backend.mtu) || backend.mtu <= 0) {
		throw new TypeError('Nostr VPN packet backend missing positive mtu');
	}
	return backend;
}

export function inspectCheerpXPacketBackendCapability({
	typeDeclarations = '',
	runtimeExports = null,
	packageName = '@leaningtech/cheerpx',
	packageVersion = '',
} = {}) {
	const networkInterfaceBlock = extractNetworkInterfaceBlock(typeDeclarations);
	const runtimeExportNames = runtimeExports && typeof runtimeExports === 'object'
		? Object.keys(runtimeExports).sort()
		: [];
	const rawSource = [typeDeclarations, runtimeExportNames.join('\n')].join('\n');
	const controlPlaneFields = CHEERPX_CONTROL_PLANE_FIELDS.filter((field) =>
		networkInterfaceBlock.includes(field),
	);
	const capabilities = Object.fromEntries(
		Object.entries(CHEERPX_PACKET_CAPABILITY_MARKERS).map(([id, markers]) => [
			id,
			hasMarker(rawSource, markers),
		]),
	);
	const missingCapabilities = Object.entries(capabilities)
		.filter(([, available]) => !available)
		.map(([id]) => id);
	const available = missingCapabilities.length === 0;
	const packageLabel = [packageName, packageVersion].filter(Boolean).join('@');
	const reason = available
		? `${packageLabel} exposes raw packet/NIC hooks for Nostr VPN.`
		: [
				`${packageLabel} does not expose the raw packet/NIC API required for Nostr VPN VM traffic.`,
				controlPlaneFields.length
					? `Detected control-plane fields: ${controlPlaneFields.join(', ')}.`
					: 'No CheerpX NetworkInterface packet surface was detected.',
				'Real VM packet routing stays disabled; no fallback networking is available.',
			].join(' ');

	return {
		available,
		package: packageLabel,
		controlPlaneFields,
		capabilities,
		missingCapabilities,
		reason,
	};
}

export function assertCheerpXPacketBackendCapability(options = {}) {
	const report = inspectCheerpXPacketBackendCapability(options);
	if (!report.available) {
		throw new NostrVpnPacketBackendUnavailableError(report);
	}
	return report;
}

export function createEndpointDataBridge({ packetBackend, fipsNode, dst }) {
	validatePacketBackend(packetBackend);
	if (!fipsNode || typeof fipsNode.sendEndpointData !== 'function' || typeof fipsNode.on !== 'function') {
		throw new TypeError('Nostr VPN FIPS node missing endpoint-data API');
	}
	if (typeof dst !== 'string' || dst.length === 0) {
		throw new TypeError('Nostr VPN bridge missing destination pubkey');
	}

	const debug = typeof globalThis !== 'undefined' && globalThis.irisWebvmV86TestHooks
		? (globalThis.irisWebvmNostrVpnBridgeDebug = {
				dst,
				txPackets: [],
				rxPackets: [],
				sendErrors: [],
				injectErrors: [],
			})
		: null;
	const offPacket = packetBackend.onTxPacket((packet) => {
		debug?.txPackets.push({ bytes: packet.length, prefixHex: Array.from(packet.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('') });
		void fipsNode.sendEndpointData({ dst, payload: packet }).catch((error) => {
			debug?.sendErrors.push(error instanceof Error ? error.message : String(error));
		});
	});
	const offEndpoint = fipsNode.on('endpointData', (event) => {
		if (event?.payload instanceof Uint8Array) {
			debug?.rxPackets.push({ bytes: event.payload.length, prefixHex: Array.from(event.payload.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('') });
			try {
				void packetBackend.injectRxPacket(event.payload);
			} catch (error) {
				debug?.injectErrors.push(error instanceof Error ? error.message : String(error));
			}
		}
	});

	return () => {
		offPacket?.();
		offEndpoint?.();
	};
}

export function getNostrVpnTransportStatus() {
	return {
		...CHEERPX_PACKET_BACKEND_UNAVAILABLE,
		requiredMethods: [...CHEERPX_PACKET_BACKEND_UNAVAILABLE.requiredMethods],
	};
}
