const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_IPV6 = 0x86dd;
const ETHERTYPE_ARP = 0x0806;
const DHCP_MAGIC_COOKIE = 0x63825363;
const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;

export const DEFAULT_V86_GATEWAY_MAC = '02:00:5e:10:44:01';
export const DEFAULT_V86_GATEWAY_IP = '10.44.0.1';
export const DEFAULT_V86_DNS_SERVERS = Object.freeze(['1.1.1.1', '8.8.8.8']);

function bytesToHex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeRuntimeNetworkId(value) {
	const trimmed = String(value || '').trim();
	const withoutPrefix = trimmed.startsWith('nostr-vpn:')
		? trimmed.slice('nostr-vpn:'.length).trim()
		: trimmed;
	const compact = Array.from(withoutPrefix)
		.filter((ch) => !/\s/.test(ch) && ch !== '-')
		.join('');
	if (
		compact.length === 0
		&& Array.from(withoutPrefix).every((ch) => /\s/.test(ch) || ch === '-')
	) {
		return '';
	}
	if (compact.length > 0 && /^[0-9a-f]+$/i.test(compact)) {
		return compact.toLowerCase();
	}
	return withoutPrefix;
}

export async function deriveMeshTunnelIpv4(networkId, ownPubkeyHex) {
	const normalizedNetworkId = normalizeRuntimeNetworkId(networkId);
	const pubkey = String(ownPubkeyHex || '').trim();
	if (!normalizedNetworkId || !pubkey) {
		throw new TypeError('network id and pubkey are required to derive a Nostr VPN tunnel IP');
	}
	const bytes = new TextEncoder().encode(`${normalizedNetworkId}\n${pubkey}`);
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
	return `10.44.${(digest[0] % 254) + 1}.${(digest[1] % 254) + 1}`;
}

function parseMac(value) {
	if (value instanceof Uint8Array && value.length === 6) {
		return new Uint8Array(value);
	}
	const parts = String(value || '').split(':');
	if (parts.length !== 6) {
		throw new TypeError(`invalid MAC address: ${value}`);
	}
	return new Uint8Array(parts.map((part) => {
		const parsed = Number.parseInt(part, 16);
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) {
			throw new TypeError(`invalid MAC address: ${value}`);
		}
		return parsed;
	}));
}

function parseIpv4(value) {
	if (value instanceof Uint8Array && value.length === 4) {
		return new Uint8Array(value);
	}
	const parts = String(value || '').split('.');
	if (parts.length !== 4) {
		throw new TypeError(`invalid IPv4 address: ${value}`);
	}
	return new Uint8Array(parts.map((part) => {
		const parsed = Number.parseInt(part, 10);
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) {
			throw new TypeError(`invalid IPv4 address: ${value}`);
		}
		return parsed;
	}));
}

function ipv4ToString(bytes) {
	return Array.from(bytes).join('.');
}

function sameBytes(a, b) {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function ethernetFrame({ dstMac, srcMac, ethertype, payload }) {
	const frame = new Uint8Array(14 + payload.length);
	frame.set(dstMac, 0);
	frame.set(srcMac, 6);
	frame[12] = ethertype >> 8;
	frame[13] = ethertype & 0xff;
	frame.set(payload, 14);
	return frame;
}

function ethernetType(frame) {
	return frame.length >= 14 ? (frame[12] << 8) | frame[13] : 0;
}

function ipv4HeaderLength(packet) {
	return (packet[0] & 0x0f) * 4;
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

function buildIpv4UdpPacket({ srcIp, dstIp, srcPort, dstPort, payload }) {
	const ipHeaderLength = 20;
	const udpLength = 8 + payload.length;
	const totalLength = ipHeaderLength + udpLength;
	const packet = new Uint8Array(totalLength);

	packet[0] = 0x45;
	packet[1] = 0;
	packet[2] = totalLength >> 8;
	packet[3] = totalLength & 0xff;
	packet[6] = 0x40;
	packet[8] = 64;
	packet[9] = 17;
	packet.set(srcIp, 12);
	packet.set(dstIp, 16);
	const checksum = ipv4Checksum(packet.subarray(0, ipHeaderLength));
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

function udpPorts(ipPacket) {
	if (ipPacket.length < 28 || (ipPacket[0] >> 4) !== 4 || ipPacket[9] !== 17) {
		return null;
	}
	const offset = ipv4HeaderLength(ipPacket);
	if (ipPacket.length < offset + 8) {
		return null;
	}
	return {
		offset,
		srcPort: (ipPacket[offset] << 8) | ipPacket[offset + 1],
		dstPort: (ipPacket[offset + 2] << 8) | ipPacket[offset + 3],
	};
}

function parseDhcpOptions(payload) {
	const options = new Map();
	if (payload.length < 240 || payload[236] !== 0x63 || payload[237] !== 0x82 || payload[238] !== 0x53 || payload[239] !== 0x63) {
		return options;
	}
	let index = 240;
	while (index < payload.length) {
		const option = payload[index++];
		if (option === 0xff) {
			break;
		}
		if (option === 0) {
			continue;
		}
		const length = payload[index++];
		options.set(option, payload.slice(index, index + length));
		index += length;
	}
	return options;
}

function pushOption(out, code, values) {
	out.push(code, values.length, ...values);
}

function buildDhcpPayload({ request, messageType, guestIp, gatewayIp, dnsServers }) {
	const payload = new Uint8Array(236);
	payload[0] = 2;
	payload[1] = request[1];
	payload[2] = request[2];
	payload[3] = request[3];
	payload.set(request.slice(4, 8), 4);
	payload.set(request.slice(10, 12), 10);
	payload.set(guestIp, 16);
	payload.set(gatewayIp, 20);
	payload.set(request.slice(28, 44), 28);

	const options = [0x63, 0x82, 0x53, 0x63];
	pushOption(options, 53, [messageType]);
	pushOption(options, 54, [...gatewayIp]);
	pushOption(options, 51, [0, 1, 81, 128]);
	pushOption(options, 1, [255, 255, 0, 0]);
	pushOption(options, 3, [...gatewayIp]);
	pushOption(options, 6, dnsServers.flatMap((server) => [...server]));
	pushOption(options, 58, [0, 0, 168, 192]);
	pushOption(options, 59, [0, 1, 81, 128]);
	options.push(255);

	const response = new Uint8Array(payload.length + options.length);
	response.set(payload, 0);
	response.set(options, payload.length);
	return response;
}

function maybeDhcpReply(ipPacket, clientMac, config) {
	const ports = udpPorts(ipPacket);
	if (!ports || ports.srcPort !== DHCP_CLIENT_PORT || ports.dstPort !== DHCP_SERVER_PORT) {
		return null;
	}
	const payload = ipPacket.slice(ports.offset + 8);
	const options = parseDhcpOptions(payload);
	const messageType = options.get(53)?.[0];
	if (messageType !== 1 && messageType !== 3) {
		return null;
	}
	const dhcpPayload = buildDhcpPayload({
		request: payload,
		messageType: messageType === 1 ? 2 : 5,
		guestIp: config.guestIp,
		gatewayIp: config.gatewayIp,
		dnsServers: config.dnsServers,
	});
	const udpPacket = buildIpv4UdpPacket({
		srcIp: config.gatewayIp,
		dstIp: new Uint8Array([255, 255, 255, 255]),
		srcPort: DHCP_SERVER_PORT,
		dstPort: DHCP_CLIENT_PORT,
		payload: dhcpPayload,
	});
	return ethernetFrame({
		dstMac: clientMac,
		srcMac: config.gatewayMac,
		ethertype: ETHERTYPE_IPV4,
		payload: udpPacket,
	});
}

function maybeArpReply(frame, config) {
	if (frame.length < 42 || ethernetType(frame) !== ETHERTYPE_ARP) {
		return null;
	}
	const arp = frame.subarray(14);
	const operation = (arp[6] << 8) | arp[7];
	const senderMac = arp.slice(8, 14);
	const senderIp = arp.slice(14, 18);
	const targetIp = arp.slice(24, 28);
	if (operation !== 1 || !sameBytes(targetIp, config.gatewayIp)) {
		return null;
	}
	const payload = new Uint8Array(28);
	payload[0] = 0;
	payload[1] = 1;
	payload[2] = 8;
	payload[3] = 0;
	payload[4] = 6;
	payload[5] = 4;
	payload[6] = 0;
	payload[7] = 2;
	payload.set(config.gatewayMac, 8);
	payload.set(config.gatewayIp, 14);
	payload.set(senderMac, 18);
	payload.set(senderIp, 24);
	return ethernetFrame({
		dstMac: senderMac,
		srcMac: config.gatewayMac,
		ethertype: ETHERTYPE_ARP,
		payload,
	});
}

function isIpPacket(packet) {
	const version = packet[0] >> 4;
	return version === 4 || version === 6;
}

function ethertypeForIpPacket(packet) {
	const version = packet[0] >> 4;
	if (version === 4) {
		return ETHERTYPE_IPV4;
	}
	if (version === 6) {
		return ETHERTYPE_IPV6;
	}
	throw new TypeError('Nostr VPN gateway received a non-IP packet');
}

export function createV86L3PacketBackend(ethernetBackend, {
	guestIp,
	gatewayIp = DEFAULT_V86_GATEWAY_IP,
	gatewayMac = DEFAULT_V86_GATEWAY_MAC,
	dnsServers = DEFAULT_V86_DNS_SERVERS,
	mtu = 1280,
} = {}) {
	if (!guestIp) {
		throw new TypeError('v86 L3 gateway requires a guest tunnel IPv4 address');
	}
	const config = {
		guestIp: parseIpv4(guestIp),
		gatewayIp: parseIpv4(gatewayIp),
		gatewayMac: parseMac(gatewayMac),
		dnsServers: dnsServers.map(parseIpv4),
	};
	let learnedGuestMac = null;

	return {
		mtu,
		onTxPacket(handler) {
			return ethernetBackend.onTxPacket((frame) => {
				if (!(frame instanceof Uint8Array) || frame.length < 14) {
					return;
				}
				const srcMac = frame.slice(6, 12);
				learnedGuestMac = srcMac;
				const arpReply = maybeArpReply(frame, config);
				if (arpReply) {
					void ethernetBackend.injectRxPacket(arpReply);
					return;
				}
				const type = ethernetType(frame);
				if (type !== ETHERTYPE_IPV4 && type !== ETHERTYPE_IPV6) {
					return;
				}
				const ipPacket = frame.slice(14);
				const dhcpReply = type === ETHERTYPE_IPV4
					? maybeDhcpReply(ipPacket, srcMac, config)
					: null;
				if (dhcpReply) {
					void ethernetBackend.injectRxPacket(dhcpReply);
					return;
				}
				if (isIpPacket(ipPacket)) {
					handler(ipPacket);
				}
			});
		},
		injectRxPacket(ipPacket) {
			if (!(ipPacket instanceof Uint8Array) || !isIpPacket(ipPacket)) {
				throw new TypeError('v86 L3 gateway can only inject IPv4/IPv6 packets');
			}
			if (!learnedGuestMac) {
				throw new Error('v86 L3 gateway has not learned the guest MAC address');
			}
			return ethernetBackend.injectRxPacket(ethernetFrame({
				dstMac: learnedGuestMac,
				srcMac: config.gatewayMac,
				ethertype: ethertypeForIpPacket(ipPacket),
				payload: ipPacket,
			}));
		},
		status() {
			return {
				guestIp: ipv4ToString(config.guestIp),
				gatewayIp: ipv4ToString(config.gatewayIp),
				gatewayMac: bytesToHex(config.gatewayMac),
				guestMac: learnedGuestMac ? bytesToHex(learnedGuestMac) : '',
				dnsServers: config.dnsServers.map(ipv4ToString),
				mtu,
			};
		},
	};
}
