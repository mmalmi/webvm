import { expect, test } from '@playwright/test';
import {
	createV86L3PacketBackend,
	deriveMeshTunnelIpv4,
} from '../../src/lib/v86L3Gateway.js';
import { createNostrVpnV86PacketBackend } from '../../src/lib/v86PacketBackend.js';

const GUEST_MAC = new Uint8Array([0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
const GATEWAY_MAC = new Uint8Array([0x02, 0x00, 0x5e, 0x10, 0x44, 0x01]);
const BROADCAST_MAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const GUEST_IP = new Uint8Array([10, 44, 205, 17]);
const GATEWAY_IP = new Uint8Array([10, 44, 0, 1]);

function ethernetFrame({ dstMac = GATEWAY_MAC, srcMac = GUEST_MAC, ethertype, payload }) {
	const frame = new Uint8Array(14 + payload.length);
	frame.set(dstMac, 0);
	frame.set(srcMac, 6);
	frame[12] = ethertype >> 8;
	frame[13] = ethertype & 0xff;
	frame.set(payload, 14);
	return frame;
}

function ipv4Checksum(header) {
	let sum = 0;
	for (let i = 0; i < header.length; i += 2) {
		sum += (header[i] << 8) + (header[i + 1] || 0);
		while (sum > 0xffff) {
			sum = (sum & 0xffff) + (sum >>> 16);
		}
	}
	return (~sum) & 0xffff;
}

function ipv4Packet({ srcIp = GUEST_IP, dstIp = new Uint8Array([203, 0, 113, 7]), protocol = 1, payload = new Uint8Array([1, 2, 3, 4]) } = {}) {
	const packet = new Uint8Array(20 + payload.length);
	packet[0] = 0x45;
	packet[2] = packet.length >> 8;
	packet[3] = packet.length & 0xff;
	packet[8] = 64;
	packet[9] = protocol;
	packet.set(srcIp, 12);
	packet.set(dstIp, 16);
	const checksum = ipv4Checksum(packet.subarray(0, 20));
	packet[10] = checksum >> 8;
	packet[11] = checksum & 0xff;
	packet.set(payload, 20);
	return packet;
}

function arpRequest() {
	const payload = new Uint8Array(28);
	payload[1] = 1;
	payload[2] = 8;
	payload[4] = 6;
	payload[5] = 4;
	payload[7] = 1;
	payload.set(GUEST_MAC, 8);
	payload.set(GUEST_IP, 14);
	payload.set(GATEWAY_IP, 24);
	return ethernetFrame({
		dstMac: BROADCAST_MAC,
		ethertype: 0x0806,
		payload,
	});
}

function udpPacket({ srcIp = new Uint8Array([0, 0, 0, 0]), dstIp = new Uint8Array([255, 255, 255, 255]), srcPort = 68, dstPort = 67, payload }) {
	const udpLength = 8 + payload.length;
	const packet = new Uint8Array(20 + udpLength);
	packet[0] = 0x45;
	packet[2] = packet.length >> 8;
	packet[3] = packet.length & 0xff;
	packet[8] = 64;
	packet[9] = 17;
	packet.set(srcIp, 12);
	packet.set(dstIp, 16);
	const checksum = ipv4Checksum(packet.subarray(0, 20));
	packet[10] = checksum >> 8;
	packet[11] = checksum & 0xff;
	packet[20] = srcPort >> 8;
	packet[21] = srcPort & 0xff;
	packet[22] = dstPort >> 8;
	packet[23] = dstPort & 0xff;
	packet[24] = udpLength >> 8;
	packet[25] = udpLength & 0xff;
	packet.set(payload, 28);
	return packet;
}

function dhcpDiscover() {
	const payload = new Uint8Array(244);
	payload[0] = 1;
	payload[1] = 1;
	payload[2] = 6;
	payload[4] = 0x12;
	payload[5] = 0x34;
	payload[6] = 0x56;
	payload[7] = 0x78;
	payload.set(GUEST_MAC, 28);
	payload[236] = 0x63;
	payload[237] = 0x82;
	payload[238] = 0x53;
	payload[239] = 0x63;
	payload[240] = 53;
	payload[241] = 1;
	payload[242] = 1;
	payload[243] = 255;
	return ethernetFrame({
		dstMac: BROADCAST_MAC,
		ethertype: 0x0800,
		payload: udpPacket({ payload }),
	});
}

function fakeEthernetBackend() {
	let txHandler;
	const injected = [];
	return {
		injected,
		emitTx(packet) {
			txHandler(packet);
		},
		onTxPacket(handler) {
			txHandler = handler;
			return () => {
				txHandler = null;
			};
		},
		injectRxPacket(packet) {
			injected.push(packet);
		},
	};
}

test('Nostr VPN v86 gateway derives the same mesh tunnel IP shape as native', async () => {
	await expect(deriveMeshTunnelIpv4(
		'550e8400-e29b-41d4-a716-446655440000',
		'a'.repeat(64),
	)).resolves.toBe('10.44.205.17');
	await expect(deriveMeshTunnelIpv4(
		'nostr-vpn: mesh-home ',
		'0123456789abcdef'.repeat(4),
	)).resolves.toBe('10.44.209.226');
});

test('Nostr VPN v86 gateway answers guest ARP locally', () => {
	const ethernet = fakeEthernetBackend();
	const gateway = createV86L3PacketBackend(ethernet, { guestIp: '10.44.205.17' });
	const outbound = [];
	gateway.onTxPacket((packet) => outbound.push(packet));

	ethernet.emitTx(arpRequest());

	expect(outbound).toEqual([]);
	expect(ethernet.injected).toHaveLength(1);
	const reply = ethernet.injected[0];
	expect(reply.slice(0, 6)).toEqual(GUEST_MAC);
	expect(reply.slice(6, 12)).toEqual(GATEWAY_MAC);
	expect(reply[12]).toBe(0x08);
	expect(reply[13]).toBe(0x06);
	expect(reply.slice(22, 28)).toEqual(GATEWAY_MAC);
	expect(reply.slice(28, 32)).toEqual(GATEWAY_IP);
});

test('Nostr VPN v86 gateway answers DHCP locally', () => {
	const ethernet = fakeEthernetBackend();
	const gateway = createV86L3PacketBackend(ethernet, { guestIp: '10.44.205.17' });
	gateway.onTxPacket(() => {});

	ethernet.emitTx(dhcpDiscover());

	expect(ethernet.injected).toHaveLength(1);
	const reply = ethernet.injected[0];
	const ip = reply.slice(14);
	const udpOffset = 14 + 20;
	const dhcp = reply.slice(udpOffset + 8);
	expect(reply.slice(0, 6)).toEqual(GUEST_MAC);
	expect(reply.slice(6, 12)).toEqual(GATEWAY_MAC);
	expect(ip.slice(12, 16)).toEqual(GATEWAY_IP);
	expect(ip.slice(16, 20)).toEqual(new Uint8Array([255, 255, 255, 255]));
	expect((reply[udpOffset] << 8) | reply[udpOffset + 1]).toBe(67);
	expect((reply[udpOffset + 2] << 8) | reply[udpOffset + 3]).toBe(68);
	expect(dhcp[0]).toBe(2);
	expect(dhcp.slice(4, 8)).toEqual(new Uint8Array([0x12, 0x34, 0x56, 0x78]));
	expect(dhcp.slice(16, 20)).toEqual(GUEST_IP);
	expect(Array.from(dhcp.slice(240))).toEqual(expect.arrayContaining([53, 1, 2, 54, 4]));
});

test('Nostr VPN v86 gateway strips ethernet for FIPS and wraps inbound IP for v86', () => {
	const ethernet = fakeEthernetBackend();
	const gateway = createV86L3PacketBackend(ethernet, { guestIp: '10.44.205.17' });
	const outbound = [];
	gateway.onTxPacket((packet) => outbound.push(packet));
	const outboundIp = ipv4Packet();

	ethernet.emitTx(ethernetFrame({ ethertype: 0x0800, payload: outboundIp }));
	gateway.injectRxPacket(ipv4Packet({
		srcIp: new Uint8Array([203, 0, 113, 7]),
		dstIp: GUEST_IP,
	}));

	expect(outbound).toEqual([outboundIp]);
	expect(ethernet.injected).toHaveLength(1);
	const inboundFrame = ethernet.injected[0];
	expect(inboundFrame.slice(0, 6)).toEqual(GUEST_MAC);
	expect(inboundFrame.slice(6, 12)).toEqual(GATEWAY_MAC);
	expect(inboundFrame[12]).toBe(0x08);
	expect(inboundFrame[13]).toBe(0x00);
	expect(inboundFrame.slice(14, 18)).toEqual(new Uint8Array([0x45, 0, 0, 24]));
	expect(gateway.status()).toMatchObject({
		guestIp: '10.44.205.17',
		gatewayIp: '10.44.0.1',
		gatewayMac: '02005e104401',
		guestMac: '02aabbccddee',
		mtu: 1280,
	});
});

test('Nostr VPN v86 packet helper composes emulator events with the L3 gateway', async () => {
	const listeners = new Map();
	const received = [];
	const emulator = {
		add_listener(event, listener) {
			listeners.set(event, listener);
		},
		remove_listener(event, listener) {
			if (listeners.get(event) === listener) {
				listeners.delete(event);
			}
		},
		bus: {
			send(event, packet) {
				received.push({ event, packet });
			},
		},
	};
	const backend = await createNostrVpnV86PacketBackend(emulator, {
		networkId: '550e8400-e29b-41d4-a716-446655440000',
		appPubkeyHex: 'a'.repeat(64),
	});
	const outbound = [];
	const stop = backend.onTxPacket((packet) => outbound.push(packet));
	const outboundIp = ipv4Packet();

	listeners.get('net0-send')(ethernetFrame({ ethertype: 0x0800, payload: outboundIp }));
	backend.injectRxPacket(ipv4Packet({
		srcIp: new Uint8Array([203, 0, 113, 7]),
		dstIp: GUEST_IP,
	}));
	stop();

	expect(outbound).toEqual([outboundIp]);
	expect(received).toHaveLength(1);
	expect(received[0].event).toBe('net0-receive');
	expect(received[0].packet.slice(0, 6)).toEqual(GUEST_MAC);
	expect(listeners.has('net0-send')).toBe(false);
	expect(backend.status()).toMatchObject({
		guestIp: '10.44.205.17',
		guestMac: '02aabbccddee',
	});
});
