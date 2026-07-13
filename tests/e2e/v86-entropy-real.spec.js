import { expect, test } from '@playwright/test';

async function sampleGuestEntropy(page) {
	await page.goto('/v86?snapshot-build');
	await page.waitForFunction(
		() => globalThis.irisWebvmV86?.state?.().terminalReady === true,
		null,
		{ timeout: 60_000 },
	);
	await page.evaluate(() => {
		const emulator = globalThis.irisWebvmV86.emulator;
		const serial = { text: '', decoder: new TextDecoder() };
		serial.onByte = (byte) => {
			serial.text += serial.decoder.decode(Uint8Array.of(byte & 0xff), { stream: true });
		};
		emulator.add_listener('serial0-output-byte', serial.onByte);
		globalThis.__entropyE2eSerial = serial;
		globalThis.irisWebvmV86.serialTerminal.reset();
		emulator.serial0_send(
			'dd if=/dev/urandom bs=32 count=1 2>/dev/null | xxd -p -c 32\n',
		);
	});
	await expect.poll(
		() => page.evaluate(() => (
			globalThis.__entropyE2eSerial.text.match(/\b[0-9a-f]{64}\b/gu) || []
		)),
		{ timeout: 15_000 },
	).toHaveLength(1);
	const output = await page.evaluate(() => globalThis.__entropyE2eSerial.text);
	const samples = output.match(/\b[0-9a-f]{64}\b/gu) || [];
	expect(samples).toHaveLength(1);
	return samples[0];
}

test('fresh restored WebVMs receive distinct browser entropy', async ({ browser }) => {
	const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
	try {
		const pages = await Promise.all(contexts.map((context) => context.newPage()));
		const samples = await Promise.all(pages.map((page) => sampleGuestEntropy(page)));
		expect(samples[0]).not.toBe(samples[1]);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
});
