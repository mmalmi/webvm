import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 90_000,
	expect: {
		timeout: 15_000,
	},
	use: {
		baseURL: 'http://127.0.0.1:4173',
		trace: 'retain-on-failure',
	},
	webServer: {
		command: 'npm run preview -- --port 4173',
		url: 'http://127.0.0.1:4173',
		reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === '1' && !process.env.CI,
		timeout: 60_000,
	},
});
