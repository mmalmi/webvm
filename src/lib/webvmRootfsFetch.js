import { isWebvmRootfsPath, shardedWebvmRootfsPath } from './webvmRootfsPath.js';

function requestUrl(input, baseUrl) {
	const value = typeof input === 'string' || input instanceof URL ? input : input?.url;
	if (!value) return null;
	try {
		return new URL(value, baseUrl);
	} catch {
		return null;
	}
}

function requestMethod(input, init) {
	return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestCacheMode(input, init) {
	return init?.cache || input?.cache || 'default';
}

export function createRootfsFetchWithCacheFallback(fetchImpl, {
	baseUrl = globalThis.location?.href,
	onFallback = () => {},
} = {}) {
	if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

	return async function fetchWithRootfsCacheFallback(input, init) {
		try {
			return await fetchImpl(input, init);
		} catch (error) {
			const url = requestUrl(input, baseUrl);
			const canRetry = requestMethod(input, init) === 'GET'
				&& requestCacheMode(input, init) !== 'no-store'
				&& url
				&& isWebvmRootfsPath(url.pathname);
			if (!canRetry) throw error;

			onFallback(error, url);
			return fetchImpl(input, { ...init, cache: 'no-store' });
		}
	};
}

export function installRootfsFetchCacheFallback({
	target = globalThis,
	onFallback = (error, url) => {
		console.warn(`Browser cache failed for ${url.pathname}; retrying without cache`, error);
	},
} = {}) {
	const nativeFetch = target.fetch;
	const wrappedFetch = createRootfsFetchWithCacheFallback(nativeFetch.bind(target), {
		baseUrl: target.location?.href,
		onFallback,
	});
	target.fetch = wrappedFetch;
	return () => {
		if (target.fetch === wrappedFetch) target.fetch = nativeFetch;
	};
}

// v86 reads guest files with XMLHttpRequest, including filenames restored
// from saved filesystem state. Rewrite before network or service worker lookup.
export function installRootfsBridgeRouting(target = globalThis) {
	const page = requestUrl(target.location?.href);
	const prototype = target.XMLHttpRequest?.prototype;
	if (!prototype || page?.protocol !== 'http:' || !page.hostname.endsWith('.iris.localhost')) return;

	const open = prototype.open;
	function routedOpen(method, input, ...options) {
		const url = String(method).toUpperCase() === 'GET' ? requestUrl(input, page.href) : null;
		if (url?.origin === page.origin && !url.search && !url.hash) {
			const sharded = shardedWebvmRootfsPath(url.pathname);
			if (sharded) {
				url.pathname = sharded;
				input = url.href;
			}
		}
		return open.call(this, method, input, ...options);
	}
	prototype.open = routedOpen;
	return () => {
		if (prototype.open === routedOpen) prototype.open = open;
	};
}
