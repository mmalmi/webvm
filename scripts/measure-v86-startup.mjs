import { chromium } from '@playwright/test';

const ROOTFS_PATH = '/v86/guest/rootfs/';
const targetUrl = process.argv[2] || 'https://webvm.iris.to/v86';
const runCount = Number.parseInt(process.argv[3] || '3', 10);
const maxStartupMs = Number.parseFloat(process.env.WEBVM_MAX_STARTUP_MS || 'Infinity');
const startupTimeoutMs = Number.parseInt(process.env.WEBVM_STARTUP_TIMEOUT_MS || '60000', 10);
const maxRevalidations = Number.parseInt(
	process.env.WEBVM_MAX_ROOTFS_REVALIDATIONS || '2147483647',
	10,
);

if (!Number.isInteger(runCount) || runCount < 1) {
	throw new Error(`run count must be a positive integer, received ${process.argv[3]}`);
}

const browser = await chromium.launch();
const results = [];

try {
	for (let run = 1; run <= runCount; run += 1) {
		const context = await browser.newContext({ serviceWorkers: 'block' });
		const page = await context.newPage();
		await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		let terminalReady = true;
		try {
			await page.waitForFunction(
				() => globalThis.irisWebvmV86?.state?.().terminalReady === true,
				null,
				{ timeout: startupTimeoutMs },
			);
		} catch (error) {
			if (error.name !== 'TimeoutError') throw error;
			terminalReady = false;
		}
		const result = await page.evaluate(({ rootfsPath, terminalReady: ready }) => {
			const resources = performance.getEntriesByType('resource');
			const rootfs = resources.filter((entry) => entry.name.includes(rootfsPath));
			const state = resources.filter((entry) => entry.name.includes('/v86/guest/state/'));
			const end = (entries) => Math.max(0, ...entries.map((entry) => entry.responseEnd));
			return {
				terminalReady: ready,
				startupMs: performance.now(),
				stateCompleteMs: end(state),
				rootfsCompleteMs: end(rootfs),
				rootfsFetches: rootfs.length,
				rootfsUniqueChunks: new Set(rootfs.map((entry) => entry.name)).size,
				rootfsConditionalRevalidations: rootfs.filter(
					(entry) => entry.transferSize > 0 && entry.transferSize < entry.encodedBodySize,
				).length,
				rootfsTransferredBytes: rootfs.reduce(
					(total, entry) => total + entry.transferSize,
					0,
				),
			};
		}, { rootfsPath: ROOTFS_PATH, terminalReady });
		results.push({ run, ...result });
		await context.close();
	}
} finally {
	await browser.close();
}

const sortedStartup = results.map(({ startupMs }) => startupMs).sort((a, b) => a - b);
const summary = {
	targetUrl,
	runs: results,
	medianStartupMs: sortedStartup[Math.floor(sortedStartup.length / 2)],
	maxRootfsConditionalRevalidations: Math.max(
		...results.map(({ rootfsConditionalRevalidations }) => rootfsConditionalRevalidations),
	),
};
console.log(JSON.stringify(summary, null, 2));

if (summary.medianStartupMs > maxStartupMs) process.exitCode = 1;
if (summary.maxRootfsConditionalRevalidations > maxRevalidations) process.exitCode = 1;
if (results.some(({ terminalReady }) => !terminalReady)) process.exitCode = 1;
