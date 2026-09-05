import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('guest retries reload before recording automatic selection and preserves later choices', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'webvm-auto-exit-'));
	const config = path.join(directory, 'config.toml');
	const calls = path.join(directory, 'calls');
	const marker = path.join(directory, '.webvm-exit-autoselect-complete');
	const bin = path.join(directory, 'bin');
	mkdirSync(bin);
	const executable = (name, source) => writeFileSync(path.join(bin, name),
		`#!/bin/sh\n${source}\n`, { mode: 0o755 });
	executable('ip', 'case "$*" in "link set"*) exit 0;; *) exit 1;; esac');
	executable('sleep', '/bin/sleep 0.01');
	executable('timeout', 'shift; exec "$@"');
	executable('nvpn', `
echo "$*" >>"$NVPN_WEBVM_STATE_DIR/calls"
case "$1" in
  daemon)
    [ "$NVPN_WEBVM_AUTO_SELECT_EXIT" = 0 ] && exit 0
    for i in $(seq 1 100); do
      [ -f "$NVPN_WEBVM_STATE_DIR/.webvm-exit-autoselect-complete" ] && exit 0
      /bin/sleep 0.01
    done
    exit 1;;
  set)
    case "$*" in *--exit-node*)
      printf 'internet_source = "private_vpn"\\n' >"$NVPN_WEBVM_CONFIG";;
    esac;;
  reload)
    if [ ! -f "$NVPN_WEBVM_STATE_DIR/reload-failed" ]; then
      touch "$NVPN_WEBVM_STATE_DIR/reload-failed"
      exit 1
    fi;;
esac`);
	writeFileSync(path.join(directory, 'daemon.state.json'), JSON.stringify({ peers: [{
		participant_pubkey: 'available-exit', advertised_routes: ['0.0.0.0/0'], reachable: true,
	}] }, null, 2));
	const run = (extraEnv = {}) => {
		writeFileSync(calls, '');
		const result = spawnSync('/bin/sh', ['dockerfiles/webvm-nvpn.sh'], {
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				NVPN_WEBVM_STATE_DIR: directory,
				NVPN_WEBVM_CONFIG: config,
				WEBVM_RUNTIME_DIR: directory,
				WEBVM_LIBEXEC_DIR: path.resolve('dockerfiles'),
				...extraEnv,
			},
			encoding: 'utf8', timeout: 5_000,
		});
		assert.equal(result.status, 0, result.stderr);
		return readFileSync(calls, 'utf8');
	};
	try {
		writeFileSync(config, 'internet_source = "direct"\n');
		const selected = run();
		assert.equal(selected.match(/--exit-node available-exit/gu)?.length, 1);
		assert.equal(selected.match(/^reload /gmu)?.length, 2);
		assert.ok(existsSync(marker));

		writeFileSync(config, 'internet_source = "direct"\n');
		assert.doesNotMatch(run(), /--exit-node|^reload /mu);
		assert.equal(readFileSync(config, 'utf8'), 'internet_source = "direct"\n');

		rmSync(marker);
		assert.doesNotMatch(run({ NVPN_WEBVM_AUTO_SELECT_EXIT: '0' }), /--exit-node|^reload /mu);
		assert.ok(!existsSync(marker));

		writeFileSync(config, 'internet_source = "wireguard"\n');
		assert.doesNotMatch(run(), /--exit-node|^reload /mu);
		assert.ok(existsSync(marker));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
