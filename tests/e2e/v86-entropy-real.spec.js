import { expect, test } from '@playwright/test';

async function terminalText(page) {
	return page.evaluate(() => {
		const buffer = globalThis.irisWebvmV86.serialTerminal.buffer.active;
		const lines = [];
		for (let index = 0; index < buffer.length; index += 1) {
			lines.push(buffer.getLine(index)?.translateToString(true) || '');
		}
		return lines.join('\n');
	});
}

async function sampleGuestEntropy(page, marker) {
	await page.goto('/v86?snapshot-build');
	await page.waitForFunction(
		() => globalThis.irisWebvmV86?.state?.().terminalReady === true,
		null,
		{ timeout: 60_000 },
	);
	await page.evaluate((done) => {
		globalThis.irisWebvmV86.serialTerminal.reset();
		globalThis.irisWebvmV86.emulator.serial0_send(
			`dd if=/dev/urandom bs=32 count=1 2>/dev/null | xxd -p -c 32; printf '${done}\\n'\n`,
		);
	}, marker);
	await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain(marker);
	const output = await terminalText(page);
	const samples = output.match(/\b[0-9a-f]{64}\b/gu) || [];
	expect(samples).toHaveLength(1);
	return samples[0];
}

test('fresh restored WebVMs receive distinct browser entropy', async ({ browser }) => {
	const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
	try {
		const pages = await Promise.all(contexts.map((context) => context.newPage()));
		const samples = await Promise.all(pages.map((page, index) => (
			sampleGuestEntropy(page, `__ENTROPY_SAMPLE_${index}__`)
		)));
		expect(samples[0]).not.toBe(samples[1]);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
});
