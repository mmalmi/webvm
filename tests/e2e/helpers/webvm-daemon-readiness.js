export async function waitForGuestNvpnDaemon({ page, runSerialCommand }) {
	const ready =
		"rc-service webvm-nvpn status >/dev/null 2>&1 " +
		"&& find /var/lib/nvpn/.nvpn-runtime -type s -name 'join-*.sock' 2>/dev/null " +
		"| grep -q .";
	const deadline = Date.now() + 300_000;
	let lastReadinessError;
	while (Date.now() < deadline) {
		try {
			await runSerialCommand(
				page,
				'ordinary nVPN daemon readiness probe',
				ready,
				20_000,
			);
			return;
		} catch (error) {
			lastReadinessError = error;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	const diagnostics = await runSerialCommand(
		page,
		'ordinary nVPN daemon startup diagnostics',
		"rc-service webvm-nvpn status || true; echo __STATE__; " +
			"cat /var/lib/nvpn/daemon.state.json 2>&1 || true; echo __LOG__; " +
			"cat /var/lib/nvpn/daemon.log 2>&1 || true; echo __SERVICE_LOG__; " +
			"cat /var/log/webvm-nvpn.log 2>&1 || true; true",
		30_000,
	);
	throw new Error(
		`ordinary nVPN daemon did not become ready: ` +
			`${lastReadinessError?.message || 'no completed probe'}\n${diagnostics.join('\n')}`,
	);
}
