const CONTENT_ADDRESSED_ROOTFS_PATH = /^\/v86\/guest\/rootfs\/[0-9a-f]{8}\.bin\.zst$/u;

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
				&& CONTENT_ADDRESSED_ROOTFS_PATH.test(url.pathname);
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
