import { expect, test } from '@playwright/test';

import { createRootfsFetchWithCacheFallback, installRootfsBridgeRouting } from '../../src/lib/webvmRootfsFetch.js';

const ROOTFS_URL = 'https://webvm.iris.to/v86/guest/rootfs/98d1f850.bin.zst';

test('rootfs fetch retries without the browser cache after a cache-path failure', async () => {
	const calls = [];
	const cacheFailure = new TypeError('Failed to fetch');
	const fetchImpl = async (input, init) => {
		calls.push({ input, init });
		if (calls.length === 1) throw cacheFailure;
		return new Response('rootfs');
	};
	const fallbacks = [];
	const fetchWithFallback = createRootfsFetchWithCacheFallback(fetchImpl, {
		baseUrl: 'https://webvm.iris.to/',
		onFallback: (error) => fallbacks.push(error),
	});

	const response = await fetchWithFallback(ROOTFS_URL);

	expect(await response.text()).toBe('rootfs');
	expect(calls).toEqual([
		{ input: ROOTFS_URL, init: undefined },
		{ input: ROOTFS_URL, init: { cache: 'no-store' } },
	]);
	expect(fallbacks).toEqual([cacheFailure]);
});

test('rootfs fetch does not retry unrelated, non-GET, or already bypassed requests', async () => {
	for (const [input, init] of [
		['https://webvm.iris.to/v86/guest/fs.json', undefined],
		[ROOTFS_URL, { method: 'POST' }],
		[ROOTFS_URL, { cache: 'no-store' }],
	]) {
		let calls = 0;
		const fetchWithFallback = createRootfsFetchWithCacheFallback(async () => {
			calls += 1;
			throw new TypeError('Failed to fetch');
		}, { baseUrl: 'https://webvm.iris.to/' });

		await expect(fetchWithFallback(input, init)).rejects.toThrow('Failed to fetch');
		expect(calls).toBe(1);
	}
});

test('v86 guest XHR sends legacy filenames to their native bridge shards before any worker controls the page', () => {
	const bridge = 'http://webvm-site.example.iris.localhost:17321';
	const flat = '/v86/guest/rootfs/98d1f850.bin.zst';
	const sharded = '/v86/guest/rootfs/9/8/98d1f850.bin.zst';
	const calls = [];
	class TestXhr {
		open(...args) {
			calls.push(args);
		}
	}
	const original = TestXhr.prototype.open;
	const request = new TestXhr();
	const restore = installRootfsBridgeRouting({ location: { href: bridge + '/' }, XMLHttpRequest: TestXhr });
	request.open('GET', flat, true);
	request.open('GET', bridge + sharded);
	request.open('GET', ROOTFS_URL);
	request.open('GET', flat + '?token=test');
	request.open('POST', flat);
	restore();
	expect(calls).toEqual([
		['GET', bridge + sharded, true],
		['GET', bridge + sharded],
		['GET', ROOTFS_URL],
		['GET', flat + '?token=test'],
		['POST', flat],
	]);
	expect(TestXhr.prototype.open).toBe(original);
	expect(installRootfsBridgeRouting({ location: { href: ROOTFS_URL }, XMLHttpRequest: TestXhr })).toBeUndefined();
	expect(TestXhr.prototype.open).toBe(original);
});
