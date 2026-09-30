import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const origin = 'https://webvm.iris.to';
const source = readFileSync('src/service-worker.js', 'utf8').replace(/^import .*;\n/u, '');
const rootfs = '/v86/guest/rootfs/1234abcd.bin.zst';

function worker(version = 'one', stores = new Map()) {
	const listeners = new Map();
	const requests = [];
	let claimed = false;
	const fetch = async (request) => {
		const url = new URL(typeof request === 'string' ? request : request.url, origin);
		requests.push(url.pathname);
		return url.pathname === '/v86/guest/state/manifest.json'
			? Response.json({ chunks: [{ file: 'state-000.bin' }] })
			: new Response(`${version}:${url.pathname}`);
	};
	const caches = {
		keys: async () => [...stores.keys()],
		delete: async (name) => stores.delete(name),
		async open(name) {
			if (!stores.has(name)) stores.set(name, new Map());
			const entries = stores.get(name);
			const key = (request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
			return {
				match: async (request) => entries.get(key(request))?.clone(),
				put: async (request, response) => entries.set(key(request), response),
				async addAll(requests) {
					for (const request of requests) entries.set(key(request), await fetch(request));
				},
			};
		},
	};
	runInNewContext(source, {
		build: ['/_app/immutable/app.js'], files: ['/favicon.ico'], prerendered: ['/', '/v86'], version,
		URL, Response, caches, fetch,
		Request: class extends Request {
			constructor(url, options) { super(new URL(url, origin), options); }
		},
		self: {
			location: new URL(origin),
			clients: { claim: async () => { claimed = true; } },
			addEventListener: (name, listener) => listeners.set(name, listener),
		},
	});
	return {
		stores, requests, caches, claimed: () => claimed,
		async dispatch(name) {
			let work;
			listeners.get(name)({ waitUntil: (promise) => { work = promise; } });
			await work;
		},
		request(path, options) {
			let response;
			listeners.get('fetch')({
				request: new Request(new URL(path, origin), options),
				respondWith: (promise) => { response = promise; },
			});
			return response;
		},
	};
}

test('offline cache is scoped to shipped app assets and lazy guest files', async () => {
	const current = worker();
	await current.dispatch('install');
	assert.ok(current.requests.includes('/v86/guest/state/state-000.bin'));
	assert.equal(current.requests.some((path) => path.includes('/rootfs/')), false);
	assert.equal(await (await current.request(rootfs)).text(), `one:${rootfs}`);
	const reads = current.requests.length;
	assert.equal(await (await current.request(rootfs)).text(), `one:${rootfs}`);
	assert.equal(current.requests.length, reads);
	for (const [path, options] of [
		['/private/session'], ['/serviceWorker.js'], ['https://other.example/v86/v86.wasm'],
		[`${rootfs}?token=private`], [rootfs, { method: 'POST' }],
		[rootfs, { headers: { Authorization: 'Bearer private' } }],
		[rootfs, { headers: { Range: 'bytes=0-9' } }],
	]) assert.equal(current.request(path, options), undefined, path);
});

test('an update waits for old tabs and replaces only this app cache, retaining downloaded guest files', async () => {
	const first = worker();
	await first.dispatch('install');
	await first.dispatch('activate');
	await first.request(rootfs);
	await first.caches.open('another-app:private-cache');
	const second = worker('two', first.stores);
	await second.dispatch('install');
	assert.equal(second.claimed(), false);
	assert.equal(await (await first.request('/v86/guest/fs.json')).text(), 'one:/v86/guest/fs.json');
	assert.ok(first.stores.has('iris-webvm:app-one'));
	await second.dispatch('activate');
	assert.equal(second.claimed(), true);
	assert.equal(first.stores.has('iris-webvm:app-one'), false);
	assert.ok(first.stores.has('another-app:private-cache'));
	assert.equal(await (await second.request(rootfs)).text(), `one:${rootfs}`);
	assert.equal(await (await second.request('/v86/guest/fs.json')).text(), 'two:/v86/guest/fs.json');
});

test('unavailable browser storage does not break online guest reads', async () => {
	const current = worker();
	current.caches.open = async () => { throw new Error('Storage unavailable'); };
	assert.equal(await (await current.request(rootfs)).text(), `one:${rootfs}`);
});
