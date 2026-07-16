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

const DOCUMENT_CACHE_CONTROL = 'no-store';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_ADDRESSED_ROOTFS_PATH = /^\/v86\/guest\/rootfs\/[0-9a-f]{8}\.bin\.zst$/u;
const CONTENT_ADDRESSED_APP_PATH = /^\/_app\/immutable\//u;

function withWebVmHeaders(response, url) {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(CROSS_ORIGIN_HEADERS)) {
		headers.set(name, value);
	}
	if (headers.get('content-type')?.toLowerCase().startsWith('text/html')) {
		headers.set('Cache-Control', DOCUMENT_CACHE_CONTROL);
		headers.set('Cloudflare-CDN-Cache-Control', DOCUMENT_CACHE_CONTROL);
	} else if (
		response.ok
		&& (CONTENT_ADDRESSED_ROOTFS_PATH.test(url.pathname)
			|| CONTENT_ADDRESSED_APP_PATH.test(url.pathname))
	) {
		headers.set('Cache-Control', IMMUTABLE_CACHE_CONTROL);
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
