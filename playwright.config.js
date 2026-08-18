import { defineConfig } from '@playwright/test';

const port = Number.parseInt(process.env.PLAYWRIGHT_PORT || '4173', 10);
const externalBaseURL = process.env.NVPN_WEBVM_E2E_BASE_URL?.trim();
const baseURL = externalBaseURL || `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 90_000,
	expect: {
		timeout: 15_000,
	},
	use: {
		baseURL,
		trace: 'retain-on-failure',
	},
	webServer: externalBaseURL ? undefined : {
		command: `npm run preview -- --port ${port}`,
		url: baseURL,
		reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === '1' && !process.env.CI,
		timeout: 60_000,
	},
});
