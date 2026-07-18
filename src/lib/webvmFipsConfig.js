export const DEFAULT_FIPS_RELAYS = Object.freeze([
	'wss://temp.iris.to',
]);

export const DEFAULT_FIPS_WEBSOCKET_SEED_URLS = Object.freeze([
	'wss://fips1.iris.to/fips',
	'wss://fips2.iris.to/fips',
]);

export const DEFAULT_FIPS_STUN_SERVERS = Object.freeze([
	'stun:stun.iris.to:3478',
	'stun:stun.l.google.com:19302',
	'stun:stun.cloudflare.com:3478',
]);

export const WEBVM_NOSTR_PUBSUB_FILTERS = Object.freeze([
	Object.freeze({ kinds: Object.freeze([37_195, 37_196, 7_368]), limit: 32 }),
	Object.freeze({ kinds: Object.freeze([30_064, 30_078]), limit: 32 }),
]);

export const WEBVM_FIPS_UNDERLAY_MTU = 1280;
