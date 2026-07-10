import { expect, test } from '@playwright/test';

import worker from '../../scripts/webvm-worker.mjs';

test('WebVM Worker redirects HTTP to HTTPS', async () => {
	const response = await worker.fetch(
		new Request('http://webvm.iris.to/v86'),
		{ ASSETS: { fetch: () => Promise.reject(new Error('assets must not run')) } },
	);

	expect(response.status).toBe(308);
	expect(response.headers.get('location')).toBe('https://webvm.iris.to/v86');
});

test('WebVM Worker isolates the privileged VM origin', async () => {
	const appCsp = "default-src 'self'; script-src 'self' 'sha256-test'";
	const response = await worker.fetch(
		new Request('https://webvm.iris.to/v86'),
		{ ASSETS: { fetch: () => new Response(
			`<!doctype html><meta http-equiv="content-security-policy" content="${appCsp}">`, {
			headers: { 'content-type': 'text/html' },
		}) } },
	);

	expect(response.status).toBe(200);
	expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
	expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
	expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	expect(response.headers.get('x-frame-options')).toBe('DENY');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	expect(response.headers.get('permissions-policy')).toContain('camera=()');
	const csp = response.headers.get('content-security-policy') || '';
	expect(csp).toBe("frame-ancestors 'none'");
	expect(csp).not.toContain('plausible.leaningtech.com');
	expect(await response.text()).toContain(appCsp);
});
