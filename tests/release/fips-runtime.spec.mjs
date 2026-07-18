import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	DEFAULT_FIPS_RELAYS,
	DEFAULT_FIPS_WEBSOCKET_SEED_URLS,
} from '../../src/lib/webvmFipsConfig.js';

test('browser FIPS bootstraps through the two explicit authenticated WSS seeds', () => {
	assert.deepEqual(DEFAULT_FIPS_WEBSOCKET_SEED_URLS, [
		'wss://fips1.iris.to/fips',
		'wss://fips2.iris.to/fips',
	]);
	assert.deepEqual(DEFAULT_FIPS_RELAYS, ['wss://temp.iris.to']);
});

test('browser FIPS contains no Nostr packet transport or companion carrier', () => {
	const productionSources = [
		'src/lib/optionalFipsTransport.js',
		'src/lib/webvmFipsHost.js',
	].map((file) => readFileSync(file, 'utf8')).join('\n');
	const forbidden = [
		['Nostr', 'RelayTransport'].join(''),
		['companion', 'Transports'].join(''),
		['210', '60'].join(''),
	];
	for (const term of forbidden) assert.doesNotMatch(productionSources, new RegExp(term, 'u'));
	assert.match(productionSources, /createWebvmNostrPubsubService/u);
});
