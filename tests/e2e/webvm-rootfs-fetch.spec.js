import { expect, test } from '@playwright/test';

import { createRootfsFetchWithCacheFallback } from '../../src/lib/webvmRootfsFetch.js';

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
