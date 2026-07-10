import { expect, test } from '@playwright/test';

test('deployed WebVM is isolated and boots the FIPS-connected guest', async ({ page, request }) => {
	const httpResponse = await request.get('http://webvm.iris.to/v86', { maxRedirects: 0 });
	expect(httpResponse.status()).toBe(308);
	expect(httpResponse.headers().location).toBe('https://webvm.iris.to/v86');

	const response = await page.goto('/v86');
	expect(response?.status()).toBe(200);
	const headers = response?.headers() || {};
	expect(headers['cross-origin-opener-policy']).toBe('same-origin');
	expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
	expect(headers['x-frame-options']).toBe('DENY');
	expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
	expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

	await expect(page.getByTestId('v86-route')).toBeVisible();
	await expect(page.getByTestId('v86-fips-state')).toHaveText('FIPS connected');
	await expect(page.locator('header')).toContainText(/Ethernet [1-9]\d*/);
	await expect(page.getByTestId('v86-status')).toContainText(/WebVM (loaded|ready|running)/);
	await expect(page.getByTestId('v86-serial').locator('.xterm-rows')).toContainText('Iris WebVM');
	await expect(page.getByTestId('v86-serial').locator('.xterm-rows')).toContainText(/\S+:~[#$]/);

	await expect(page.getByText('Tailscale')).toHaveCount(0);
	await expect(page.getByText('Pairing', { exact: true })).toHaveCount(0);
	await expect(page.getByTestId('v86-error')).toHaveCount(0);
});
