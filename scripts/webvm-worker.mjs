const CROSS_ORIGIN_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'cross-origin',
	'Content-Security-Policy': [
		"default-src 'self'",
		"base-uri 'none'",
		"connect-src 'self' wss://temp.iris.to wss://relay.damus.io wss://nos.lol",
		"font-src 'self' data:",
		"frame-ancestors 'none'",
		"img-src 'self' data:",
		"object-src 'none'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		"worker-src 'self' blob:",
	].join('; '),
	'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
};

function withWebVmHeaders(response) {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(CROSS_ORIGIN_HEADERS)) {
		headers.set(name, value);
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
		return withWebVmHeaders(response);
	},
};
