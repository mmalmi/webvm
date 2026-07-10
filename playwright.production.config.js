import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/production',
	timeout: 180_000,
	expect: {
		timeout: 120_000,
	},
	use: {
		baseURL: process.env.WEBVM_PRODUCTION_URL || 'https://webvm.iris.to',
		trace: 'retain-on-failure',
	},
});
