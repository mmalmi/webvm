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

export default {
	async fetch(request, env) {
		const response = await env.ASSETS.fetch(request);
		return withWebVmHeaders(response);
	},
};
