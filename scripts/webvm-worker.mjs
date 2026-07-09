const CROSS_ORIGIN_HEADERS = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Resource-Policy': 'cross-origin',
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

function rewriteWebVmSubpath(request) {
	const url = new URL(request.url);
	if (url.pathname === '/webvm') {
		url.pathname = '/webvm/';
		return Response.redirect(url.toString(), 308);
	}
	if (!url.pathname.startsWith('/webvm/')) {
		return request;
	}

	url.pathname = url.pathname.slice('/webvm'.length) || '/';
	return new Request(url, request);
}

export default {
	async fetch(request, env) {
		const assetRequest = rewriteWebVmSubpath(request);
		if (assetRequest instanceof Response) {
			return assetRequest;
		}

		const response = await env.ASSETS.fetch(assetRequest);
		return withWebVmHeaders(response);
	},
};
