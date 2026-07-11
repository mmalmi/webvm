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
	await expect(page.getByTestId('v86-status')).toContainText(/WebVM (loaded|ready|running)/);
	const terminal = page.getByTestId('v86-serial');
	const rows = terminal.locator('.xterm-rows');
	await expect(rows).toContainText('Iris WebVM');
	await expect(rows).toContainText('root@webvm:~#');
	await expect(page.locator('header')).toContainText(/WebRTC [1-9]\d*/);

	await terminal.click();
	await page.keyboard.insertText(
		'a=__WEBVM_FIRST_; b=PING_DONE__; ' +
		'ping -c 1 -W 5 npub1uf4ua9n0hm2x4ct8sqcyqfh7w0s9n5qej9gpjjqjf9z0lsmh3jtsqyduhs.fips ' +
		'&& printf "%s%s\\n" "$a" "$b"',
	);
	await page.keyboard.press('Enter');
	await expect(rows).toContainText('__WEBVM_FIRST_PING_DONE__', { timeout: 30_000 });
	await expect(rows).not.toContainText('ping: bad address');

	await page.keyboard.insertText(
		'a=__WEBVM_FIPS_; b=READY__; ' +
		'for attempt in $(seq 1 30); do ' +
		'if ping -c 1 -W 5 npub1uf4ua9n0hm2x4ct8sqcyqfh7w0s9n5qej9gpjjqjf9z0lsmh3jtsqyduhs.fips ' +
		'>/dev/null 2>&1; then printf "%s%s\\n" "$a" "$b"; break; fi; sleep 1; done',
	);
	await page.keyboard.press('Enter');
	await expect(rows).toContainText('__WEBVM_FIPS_READY__', { timeout: 180_000 });
	await expect(page.locator('header')).toContainText(/Ethernet [1-9]\d*/);

	await expect(page.getByText('Tailscale')).toHaveCount(0);
	await expect(page.getByText('Pairing', { exact: true })).toHaveCount(0);
	await expect(page.getByTestId('v86-error')).toHaveCount(0);
});
