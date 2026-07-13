const CROSS_ORIGIN_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'cross-origin',
	// SvelteKit emits the build-specific script hashes in a CSP meta tag.
	// Frame ancestry must remain an HTTP header because browsers ignore it in meta CSP.
	'Content-Security-Policy': "frame-ancestors 'none'",
	'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
};

const ROOTFS_BROWSER_CACHE_CONTROL = 'no-store';
const ROOTFS_EDGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_ADDRESSED_ROOTFS_PATH = /^\/v86\/guest\/rootfs\/[0-9a-f]{8}\.bin\.zst$/u;

function withWebVmHeaders(response, url) {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(CROSS_ORIGIN_HEADERS)) {
		headers.set(name, value);
	}
	if (CONTENT_ADDRESSED_ROOTFS_PATH.test(url.pathname)) {
		// Chromium can fail the entire VM chunk request with ERR_CACHE_WRITE_FAILURE
		// when its local disk cache is unhealthy or the host is low on storage.
		// Keep content-addressed chunks at the edge, but never make boot depend on a
		// successful browser-cache write.
		headers.set('Cache-Control', ROOTFS_BROWSER_CACHE_CONTROL);
		headers.set('Cloudflare-CDN-Cache-Control', ROOTFS_EDGE_CACHE_CONTROL);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function shouldRedirectToHttps(request, url) {
	const forwardedProto = request.headers.get('x-forwarded-proto');
	if (forwardedProto) {
		return forwardedProto.toLowerCase() === 'http';
	}
	if (request.cf && !request.cf.tlsVersion) {
		return true;
	}
	return url.protocol === 'http:';
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (shouldRedirectToHttps(request, url)) {
			url.protocol = 'https:';
			url.port = '';
			return Response.redirect(url.toString(), 308);
		}

		const response = await env.ASSETS.fetch(request);
		return withWebVmHeaders(response, url);
	},
};
