import assert from 'node:assert/strict';
import test from 'node:test';

import { createOptionalFipsTransport } from '../../src/lib/optionalFipsTransport.js';

function failingTransport(type) {
	return {
		type,
		mtu: 1280,
		starts: 0,
		stops: 0,
		async start() {
			this.starts += 1;
			throw new Error(`${type} offline`);
		},
		async stop() {
			this.stops += 1;
		},
		async connect() {},
		async send() {},
	};
}

test('an unavailable optional carrier does not fail FIPS host startup', async () => {
	const webrtc = failingTransport('webrtc');
	const failures = [];
	const optional = createOptionalFipsTransport(webrtc, {
		onUnavailable: ({ type, error }) => failures.push([type, error.message]),
	});

	await optional.start({});
	await assert.rejects(() => optional.send({}), /webrtc carrier is unavailable/u);
	assert.equal(webrtc.starts, 1);
	assert.equal(webrtc.stops, 1);
	assert.deepEqual(failures, [['webrtc', 'webrtc offline']]);
	assert.equal('companionTransports' in optional, false);
});
