function toUint8Array(frame) {
	if (frame instanceof Uint8Array) {
		return frame;
	}
	if (frame instanceof ArrayBuffer) {
		return new Uint8Array(frame);
	}
	if (ArrayBuffer.isView(frame)) {
		return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
	}
	throw new TypeError('v86 Ethernet frame must be Uint8Array-compatible');
}

function macString(frame, offset) {
	return Array.from(frame.subarray(offset, offset + 6), (byte) => (
		byte.toString(16).padStart(2, '0')
	)).join(':');
}

export function createV86EthernetFramePort(emulator, { id = 0 } = {}) {
	if (!emulator || typeof emulator.add_listener !== 'function') {
		throw new TypeError('v86 emulator missing add_listener');
	}
	if (!emulator.bus || typeof emulator.bus.send !== 'function') {
		throw new TypeError('v86 emulator missing bus.send');
	}

	const txEvent = `net${id}-send`;
	const rxEvent = `net${id}-receive`;
	const stats = {
		guestFrames: 0,
		guestFipsFrames: 0,
		guestFmpMsg1ByMac: {},
	};
	const trackGuestFrame = (frame) => {
		stats.guestFrames += 1;
		if (frame.length < 18 || frame[12] !== 0x21 || frame[13] !== 0x21) return;
		stats.guestFipsFrames += 1;
		if (frame[14] !== 0x00 || frame[17] !== 0x01) return;
		const sourceMac = macString(frame, 6);
		stats.guestFmpMsg1ByMac[sourceMac] = (stats.guestFmpMsg1ByMac[sourceMac] || 0) + 1;
	};

	return {
		stats,
		onFrame(listener) {
			if (typeof listener !== 'function') {
				throw new TypeError('Ethernet frame listener must be a function');
			}
			const receive = (frame) => {
				const bytes = new Uint8Array(toUint8Array(frame));
				trackGuestFrame(bytes);
				listener(bytes);
			};
			emulator.add_listener(txEvent, receive);
			return () => emulator.remove_listener?.(txEvent, receive);
		},
		sendFrame(frame) {
			emulator.bus.send(rxEvent, new Uint8Array(toUint8Array(frame)));
		},
	};
}
