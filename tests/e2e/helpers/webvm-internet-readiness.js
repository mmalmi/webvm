export async function waitForPrivateExitInternet({ page, runSerialCommand }) {
	try {
		await checkPrivateExitInternet({ page, runSerialCommand });
	} catch (error) {
		error.message += '\nNetwork probes:\n' + await privateExitInternetDiagnostics({
			page, runSerialCommand,
		});
		throw error;
	}
}

async function privateExitInternetDiagnostics({ page, runSerialCommand }) {
	// Keep payloads private: print only exit codes, timings, and DNS/HTTP status.
	const command = [
		'probe() { label=$1; shift; started=$(date +%s); output=$("$@" 2>&1); status=$?; ' +
			'printf "%s exit=%s elapsed_s=%s\\n" "$label" "$status" "$(( $(date +%s) - started ))"; ' +
			'printf "%s\\n" "$output" | sed -n "/^;; ->>HEADER<<-/p; /^;; Query time:/p; /^http_status=/p"; }',
		'probe "local DNS UDP" dig @127.0.0.1 example.com A +ignore +time=7 +tries=1 +noall +comments +stats',
		...['149.112.112.112', '9.9.9.9'].map((server) =>
			`probe "public DNS UDP ${server}" dig @${server} example.com A +ignore +time=3 +tries=1 +noall +comments +stats`),
		'probe "public DNS TCP" dig @9.9.9.9 example.com A +tcp +time=3 +tries=1 +noall +comments +stats',
		'probe "public ping" ping -c 1 -W 2 9.9.9.9',
		...['http', 'https'].map((scheme) =>
			`probe "public ${scheme.toUpperCase()}" curl --noproxy "*" --fail --silent --show-error ` +
			'--connect-timeout 3 --max-time 5 --output /dev/null ' +
			'--write-out "http_status=%{http_code} connect_s=%{time_connect} tls_s=%{time_appconnect} total_s=%{time_total}\\n" ' +
			`--resolve one.one.one.one:${scheme === 'https' ? 443 : 80}:1.1.1.1 ${scheme}://one.one.one.one/cdn-cgi/trace`),
	].join('; ');
	try {
		const output = await runSerialCommand(
			page,
			'failure-only Internet diagnostics',
			`timeout 35 sh -c '${command.replaceAll("'", "'\\''")}'`,
			45_000,
		);
		return output.join('\n');
	} catch {
		return 'Network probes unavailable or exceeded their deadline.';
	}
}

async function checkPrivateExitInternet({ page, runSerialCommand }) {
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
	console.log('Private exit ping passed');

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
		console.log(`${label} passed`);
	}
}
