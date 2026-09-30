import { build, files, prerendered, version } from '$service-worker';

const PREFIX = 'iris-webvm:';
const CACHE = `${PREFIX}app-${version}`;
const ROOTFS_CACHE = `${PREFIX}rootfs-v1`;
const ROOTFS = /^\/v86\/guest\/rootfs\/[0-9a-f]{8}\.bin\.zst$/u;
const STATE_CHUNK = /^\/v86\/guest\/state\/state-[0-9]+\.bin$/u;
const ASSETS = new Set([
	...build, ...files, ...prerendered,
	'/v86/v86.wasm', '/v86/v86-fallback.wasm', '/v86/seabios.bin', '/v86/vgabios.bin',
	'/v86/guest/fs.json', '/v86/guest/manifest.json', '/v86/guest/state/manifest.json',
]);

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE);
		const reload = (url) => new Request(url, { cache: 'reload' });
		await cache.addAll([...ASSETS].map(reload));
		const manifest = await (await cache.match('/v86/guest/state/manifest.json')).json();
		const chunks = manifest.chunks.map(({ file }) => `/v86/guest/state/${file}`);
		if (!chunks.every((path) => STATE_CHUNK.test(path))) throw new Error('Invalid guest state paths');
		await cache.addAll(chunks.map(reload));
		// Let existing tabs finish with their current app and guest version.
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		for (const name of await caches.keys()) {
			if (name.startsWith(PREFIX) && name !== CACHE && name !== ROOTFS_CACHE) {
				await caches.delete(name);
			}
		}
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	const page = request.mode === 'navigate' && prerendered.includes(url.pathname);
	if (request.method !== 'GET' || url.origin !== self.location.origin
		|| request.headers.has('authorization') || request.headers.has('range')
		|| (url.search && !page)) return;
	const rootfs = ROOTFS.test(url.pathname);
	if (!rootfs && !ASSETS.has(url.pathname) && !STATE_CHUNK.test(url.pathname)) return;
	event.respondWith((async () => {
		const cache = await caches.open(rootfs ? ROOTFS_CACHE : CACHE).catch(() => null);
		const cached = await cache?.match(url.pathname).catch(() => null);
		if (cached) return cached;
		const response = await fetch(request);
		if (response.status === 200 && !response.redirected && (rootfs || ASSETS.has(url.pathname))) {
			// Cache only shipped assets. Guest files remain lazy and content-addressed.
			await cache?.put(url.pathname, response.clone()).catch(() => {});
		}
		return response;
	})());
});
