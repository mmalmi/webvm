import assert from 'node:assert/strict';
import test from 'node:test';

import { createOptionalFipsTransport } from '../../src/lib/optionalFipsTransport.js';

function failingTransport(type, companion) {
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
		...(companion ? { companionTransports: () => [companion] } : {}),
	};
}

test('an unavailable optional carrier does not fail FIPS host startup', async () => {
	const relay = failingTransport('nostr_relay');
	const webrtc = failingTransport('webrtc', relay);
	const failures = [];
	const optional = createOptionalFipsTransport(webrtc, {
		onUnavailable: ({ type, error }) => failures.push([type, error.message]),
	});

	await optional.start({});
	await assert.rejects(() => optional.send({}), /webrtc carrier is unavailable/u);
	assert.equal(webrtc.starts, 1);
	assert.equal(webrtc.stops, 1);
	assert.deepEqual(failures, [['webrtc', 'webrtc offline']]);

	const [optionalRelay] = optional.companionTransports();
	await optionalRelay.start({});
	assert.equal(relay.starts, 1);
	assert.equal(relay.stops, 1);
	assert.deepEqual(failures, [
		['webrtc', 'webrtc offline'],
		['nostr_relay', 'nostr_relay offline'],
	]);
});
