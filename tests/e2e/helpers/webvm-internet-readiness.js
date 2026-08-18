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

	await runSerialCommand(
		page,
		'public DNS through the private FIPS exit',
		'nslookup example.com 9.9.9.9',
		45_000,
	);
	await runSerialCommand(
		page,
		'public HTTPS through the private FIPS exit',
		'curl --insecure --fail --silent --show-error --connect-timeout 10 --max-time 30 ' +
			"https://1.1.1.1/cdn-cgi/trace | grep -q '^ip='",
		90_000,
	);
	await runSerialCommand(
		page,
		'local secure DNS through the private FIPS exit',
		'nslookup example.com 127.0.0.1',
		45_000,
	);
}
