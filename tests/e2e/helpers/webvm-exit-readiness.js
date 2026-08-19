export async function waitForAutomaticPrivateExit({ page, expectedExit, runSerialCommand }) {
	const exitReady =
		`grep -q '^internet_source = "private_vpn"$' /var/lib/nvpn/config.toml ` +
		`&& ip -4 route show 0.0.0.0/0 | grep 'dev nvpn0' | grep -q 'mtu 1000' ` +
		`&& ! ip -4 addr show dev nvpn0 | grep -q '10.44.0.1/32' ` +
		`&& ip link show nvpn0 | grep -q 'mtu 1280' ` +
		`&& iptables -t mangle -C OUTPUT -o nvpn0 -p tcp ` +
		`--tcp-flags SYN,RST SYN -j TCPMSS --set-mss 960 ` +
		`&& ! ip link show nvpn-wg-exit >/dev/null 2>&1`;
	const deadline = Date.now() + 300_000;
	let lastReadinessError;
	while (Date.now() < deadline) {
		try {
			await runSerialCommand(
				page,
				'automatic private FIPS exit readiness probe',
				exitReady,
				20_000,
			);
			await runSerialCommand(
				page,
				'automatic private FIPS exit assertions',
				`status=$(timeout 10 nvpn status --json); ` +
					`printf '%s\\n' "$status" | grep -q '"exit_node": "${expectedExit}"' ` +
					`&& printf '%s\\n' "$status" | grep -A 14 '"wireguard_exit"' ` +
					`| grep -q '"enabled": false'`,
				30_000,
			);
			return;
		} catch (error) {
			lastReadinessError = error;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	const diagnostics = await runSerialCommand(
		page,
		'automatic private FIPS exit diagnostics',
		"echo __STATUS__; timeout 10 nvpn status || true; echo __ROUTES__; ip -4 route; " +
			"echo __LINKS__; ip -4 addr show nvpn0 2>&1 || true; " +
			"ip link show nvpn-wg-exit 2>&1 || true; true",
		30_000,
	);
	throw new Error(
		`automatic private FIPS exit did not become ready: ` +
			`${lastReadinessError?.message || 'no completed probe'}\n${diagnostics.join('\n')}`,
	);
}
