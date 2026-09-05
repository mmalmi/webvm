const redact = (text) => text
	.replace(/nvpn:\/\/\S+/gu, '[join request]')
	.replace(/npub1[a-z0-9]+|\b[0-9a-f]{64}\b/gu, '[peer identity]');

export async function guestControlDiagnostics({ page, runSerialCommand }) {
	try {
		const output = await runSerialCommand(
			page,
			'post-approval control diagnostics',
			'echo __SERVICE__; rc-service webvm-nvpn status || true; ' +
				'echo __CONTROL__; for f in /var/lib/nvpn/daemon.control ' +
				'/var/lib/nvpn/daemon.control.ready /var/lib/nvpn/daemon.control.result.json ' +
				'/var/lib/nvpn/.webvm-exit-autoselect-complete; do ' +
				'if test -f "$f"; then ls -l "$f"; head -c 2048 "$f"; echo; fi; done; ' +
				'echo __STATE__; date +%s; ' +
				'grep -E \'"(updated_at|binary_version|fips_core_version|vpn_active|vpn_status|' +
				'expected_peer_count|connected_peer_count|fips_other_peer_count)"\' ' +
				'/var/lib/nvpn/daemon.state.json; echo __PROCESS__; ' +
				'pid=$(sed -n \'s/.*"pid": \\([0-9]*\\).*/\\1/p\' /var/lib/nvpn/daemon.pid); ' +
				'if test -n "$pid"; then ' +
				'grep -E "^(Name|State|Threads|VmRSS):" /proc/$pid/status; cat /proc/$pid/wchan; fi; ' +
				'echo __ROUTES__; ip -4 route; echo __LOG__; ' +
				'tail -n 80 /var/lib/nvpn/daemon.log; true',
			30_000,
		);
		return redact(output.join('\n'));
	} catch (error) {
		return redact(`Guest diagnostics unavailable: ${error.message}`);
	}
}

export async function assertApprovedJoinRequest({ page, runSerialCommand }) {
	try {
		await runSerialCommand(
			page,
			'already-approved join-request rejection',
			'if output=$(nvpn join-request --no-qr --no-wait 2>&1); then ' +
				"printf 'approved device unexpectedly received another request\\n'; exit 1; " +
				'elif ! printf \'%s\\n\' "$output" | grep -Fq \'already approved\'; then ' +
				'printf \'__UNEXPECTED_APPROVED_RESULT__\\n%s\\n\' "$output"; exit 1; fi',
			15_000,
		);
	} catch (error) {
		const diagnostics = await guestControlDiagnostics({ page, runSerialCommand });
		throw new Error(`${redact(error.message)}\n${diagnostics}`);
	}
}
