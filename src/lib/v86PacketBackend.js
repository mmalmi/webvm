import { validatePacketBackend } from './nostrVpnTransport.js';
import {
	createV86L3PacketBackend,
	deriveMeshTunnelIpv4,
} from './v86L3Gateway.js';

function toUint8Array(packet) {
	if (packet instanceof Uint8Array) {
		return packet;
	}
	if (packet instanceof ArrayBuffer) {
		return new Uint8Array(packet);
	}
	if (ArrayBuffer.isView(packet)) {
		return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
	}
	throw new TypeError('v86 packet must be Uint8Array-compatible');
}

export function createV86PacketBackend(emulator, { id = 0, mtu = 1200 } = {}) {
	if (!emulator || typeof emulator.add_listener !== 'function') {
		throw new TypeError('v86 emulator missing add_listener');
	}
	if (!emulator.bus || typeof emulator.bus.send !== 'function') {
		throw new TypeError('v86 emulator missing bus.send');
	}

	const txEvent = `net${id}-send`;
	const rxEvent = `net${id}-receive`;

	return validatePacketBackend({
		mtu,
		onTxPacket(handler) {
			const listener = (packet) => handler(toUint8Array(packet));
			emulator.add_listener(txEvent, listener);
			return () => {
				emulator.remove_listener?.(txEvent, listener);
			};
		},
		injectRxPacket(packet) {
			emulator.bus.send(rxEvent, toUint8Array(packet));
		},
	});
}

export async function createNostrVpnV86PacketBackend(
	emulator,
	{
		networkId,
		appPubkeyHex,
		id = 0,
		ethernetMtu = 1500,
		mtu = 1280,
		gatewayIp,
		gatewayMac,
		dnsServers,
	} = {},
) {
	const guestIp = await deriveMeshTunnelIpv4(networkId, appPubkeyHex);
	const ethernetBackend = createV86PacketBackend(emulator, { id, mtu: ethernetMtu });
	return validatePacketBackend(createV86L3PacketBackend(ethernetBackend, {
		guestIp,
		gatewayIp,
		gatewayMac,
		dnsServers,
		mtu,
	}));
}
