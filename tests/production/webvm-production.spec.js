import { expect, test } from '@playwright/test';

const LNVPS_FIPS_NAME =
	'npub1uf4ua9n0hm2x4ct8sqcyqfh7w0s9n5qej9gpjjqjf9z0lsmh3jtsqyduhs.fips';

test('deployed WebVM bypasses browser cache writes for content-addressed rootfs chunks', async ({ request }) => {
	const filesystem = await request.get('/v86/guest/fs.json');
	expect(filesystem.status()).toBe(200);
	const chunkName = (await filesystem.text()).match(/[0-9a-f]{8}\.bin\.zst/u)?.[0];
	expect(chunkName).toBeTruthy();

	const chunk = await request.head(`/v86/guest/rootfs/${chunkName}`);
	expect(chunk.status()).toBe(200);
	expect(chunk.headers()['cache-control']).toBe('no-store');
	expect(chunk.headers()['cloudflare-cdn-cache-control'])
		.toBe('public, max-age=31536000, immutable');
});

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
		'a=__FIPS_; b=ONLY__; ' +
		'for attempt in $(seq 1 150); do test -f /var/lib/nvpn/config.toml && break; sleep 0.1; done; ' +
		'nvpn status | grep -q "^fips_bootstrap_enabled: false$" ' +
		'&& printf "%s%s\\n" "$a" "$b"',
	);
	await page.keyboard.press('Enter');
	await expect(rows).toContainText('__FIPS_ONLY__', { timeout: 15_000 });

	await page.keyboard.insertText(
		'a=__WEBVM_FIPS_; b=READY__; ' +
		'for attempt in $(seq 1 30); do ' +
		`if ping -c 1 -W 5 ${LNVPS_FIPS_NAME} ` +
		'>/dev/null 2>&1; then printf "%s%s\\n" "$a" "$b"; break; fi; sleep 1; done',
	);
	await page.keyboard.press('Enter');
	await expect(rows).toContainText('__WEBVM_FIPS_READY__', { timeout: 180_000 });
	await expect(page.locator('header')).toContainText(/Ethernet [1-9]\d*/);

	await expect(page.getByText('Tailscale')).toHaveCount(0);
	await expect(page.getByText('Pairing', { exact: true })).toHaveCount(0);
	await expect(page.getByTestId('v86-error')).toHaveCount(0);
});

test('deployed WebVM handles a concurrent Nostr-discovered WebRTC burst', async ({ browser }) => {
	const baseURL = process.env.WEBVM_PRODUCTION_URL || 'https://webvm.iris.to';
	const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
	const pages = await Promise.all(contexts.map((context) => context.newPage()));

	try {
		await Promise.all(pages.map(async (page) => {
			const response = await page.goto(`${baseURL}/v86`);
			expect(response?.status()).toBe(200);
			await expect(page.getByTestId('v86-fips-state')).toHaveText('FIPS connected');
			const rows = page.getByTestId('v86-serial').locator('.xterm-rows');
			await expect(rows).toContainText('root@webvm:~#');
			await expect(page.locator('header')).toContainText(/WebRTC [1-9]\d*/);
		}));

		await Promise.all(pages.map(async (page, index) => {
			const terminal = page.getByTestId('v86-serial');
			const rows = terminal.locator('.xterm-rows');
			const marker = `__WEBVM_BURST_${index}_OK__`;
			await terminal.click();
			await page.keyboard.insertText(
				`ping -c 1 -W 8 ${LNVPS_FIPS_NAME} >/dev/null && printf '${marker}\\n'`,
			);
			await page.keyboard.press('Enter');
			await expect(rows).toContainText(marker, { timeout: 30_000 });
			await expect(rows).not.toContainText('ping: bad address');
		}));
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
});

test('five fresh WebVMs deliver their first FIPS ping without resolver or session loss', async ({
	browser,
}) => {
	test.setTimeout(300_000);
	const baseURL = process.env.WEBVM_PRODUCTION_URL || 'https://webvm.iris.to';
	const localHeaders = baseURL.startsWith('http://')
		? { 'x-forwarded-proto': 'https' }
		: undefined;

	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const startedAt = Date.now();
		const context = await browser.newContext({ extraHTTPHeaders: localHeaders });
		try {
			const page = await context.newPage();
			const response = await page.goto(`${baseURL}/v86`);
			expect(response?.status()).toBe(200);
			await expect(page.getByTestId('v86-fips-state')).toHaveText('FIPS connected');
			await expect(page.locator('header')).toContainText(/WebRTC [1-9]\d*/);
			const terminal = page.getByTestId('v86-serial');
			const rows = terminal.locator('.xterm-rows');
			await expect(rows).toContainText('root@webvm:~#');

			const marker = `__WEBVM_FRESH_FIRST_PING_${attempt}_OK__`;
			await terminal.click();
			await page.keyboard.insertText(
				`ping -c 1 -W 8 ${LNVPS_FIPS_NAME} >/dev/null && printf '${marker}\\n'`,
			);
			await page.keyboard.press('Enter');
			await expect(rows).toContainText(marker, { timeout: 30_000 });
			await expect(rows).not.toContainText('ping: bad address');
			console.log(`fresh first ping ${attempt}/5 passed in ${Date.now() - startedAt}ms`);
		} finally {
			await context.close();
		}
	}
});
