export async function waitForPrivateExitInternet({ page, runSerialCommand }) {
	const deadline = Date.now() + 300_000;
	let lastReadinessError;
	while (Date.now() < deadline) {
		try {
			await runSerialCommand(
				page,
				'private FIPS exit ICMP readiness probe',
				"ip route get 9.9.9.9 | grep -q 'dev nvpn0' " +
					'&& ping -c 1 -W 2 9.9.9.9',
				20_000,
			);
			lastReadinessError = null;
			break;
		} catch (error) {
			lastReadinessError = error;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	if (lastReadinessError) {
		throw new Error(
			`private FIPS exit did not pass its ICMP readiness probe: ${lastReadinessError.message}`,
		);
	}

	const checks = [
		['system DNS', 'timeout 10 nslookup example.com'],
		['public DNS', '( timeout 10 nslookup example.com 9.9.9.9 ' +
			'|| timeout 10 nslookup example.com 149.112.112.112 )'],
		...['http', 'https'].map((scheme) => [
			`public ${scheme.toUpperCase()}`,
			'curl --fail --silent --show-error --connect-timeout 10 --max-time 30 ' +
				`--output /tmp/webvm-internet-probe ${scheme}://example.com/ ` +
				`&& grep -q 'Example Domain' /tmp/webvm-internet-probe`,
		]),
	];
	for (const [label, command] of checks) {
		await runSerialCommand(
			page,
			`${label} through the private FIPS exit`,
			`for i in $(seq 1 5); do ${command} && exit 0; sleep 2; done; exit 1`,
			180_000,
		);
	}
}
