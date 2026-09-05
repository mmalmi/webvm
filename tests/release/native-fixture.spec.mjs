import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectNativeFixture } from '../../scripts/native-fixture.mjs';

const FIPS_CHECKSUM = 'a'.repeat(64);

function run(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function fixtureRepository() {
	const repository = mkdtempSync(path.join(tmpdir(), 'iris-webvm-native-fixture-'));
	mkdirSync(path.join(repository, 'crates/nostr-vpn-app-core'), { recursive: true });
	writeFileSync(path.join(repository, 'Cargo.toml'), `[workspace]\nmembers = ["crates/nostr-vpn-app-core"]\n\n[workspace.package]\nversion = "4.0.94"\n\n[workspace.dependencies]\nfips-core = { package = "nvpn-fips-core", version = "=0.4.4" }\nfips-endpoint = { package = "nvpn-fips-endpoint", version = "=0.4.4" }\n`);
	writeFileSync(path.join(repository, 'Cargo.lock'), `version = 4\n\n[[package]]\nname = "nvpn-fips-core"\nversion = "0.4.4"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${FIPS_CHECKSUM}"\n\n[[package]]\nname = "nvpn-fips-endpoint"\nversion = "0.4.4"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${FIPS_CHECKSUM}"\n`);
	const manifest = path.join(repository, 'crates/nostr-vpn-app-core/Cargo.toml');
	writeFileSync(manifest, '[package]\nname = "nostr-vpn-app-core"\nversion.workspace = true\n');
	const binary = path.join(repository, 'nvpn');
	writeFileSync(binary, '#!/bin/sh\nprintf "nvpn 4.0.94\\n"\n');
	chmodSync(binary, 0o755);
	run('git', ['init', '--quiet'], repository);
	run('git', ['config', 'user.email', 'fixture@example.invalid'], repository);
	run('git', ['config', 'user.name', 'Fixture'], repository);
	run('git', ['add', '.'], repository);
	run('git', ['commit', '--quiet', '-m', 'fixture'], repository);
	const commit = run('git', ['rev-parse', 'HEAD'], repository);
	run('git', ['update-ref', 'refs/remotes/github/master', commit], repository);
	return { repository, manifest, binary, commit };
}

test('native gate rejects implicit fixture discovery', () => {
	assert.throws(
		() => inspectNativeFixture({}),
		/NVPN_WEBVM_NVPN_BIN is required/u,
	);
});

test('guest builder rejects implicit sibling repositories and binaries', () => {
	const result = spawnSync('bash', ['scripts/build-v86-guest.sh'], {
		cwd: path.resolve(import.meta.dirname, '../..'),
		env: { HOME: process.env.HOME, PATH: process.env.PATH },
		encoding: 'utf8',
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^NVPN_REPO_PATH is required/u);
});

test('native gate attests an explicit clean public source and registry FIPS release', () => {
	const fixture = fixtureRepository();
	try {
		const env = {
			NVPN_WEBVM_NVPN_BIN: fixture.binary,
			NVPN_APP_CORE_MANIFEST: fixture.manifest,
			NVPN_WEBVM_NATIVE_SOURCE_SHA: fixture.commit,
			NVPN_WEBVM_FIPS_VERSION: '0.4.4',
		};
		const facts = inspectNativeFixture(env);
		assert.equal(facts.sourceCommit, fixture.commit);
		assert.equal(facts.nvpnVersion, '4.0.94');
		assert.equal(facts.fipsCore.checksum, FIPS_CHECKSUM);
		assert.equal(facts.fipsEndpoint.version, '0.4.4');
		assert.match(facts.nvpnSha256, /^[0-9a-f]{64}$/u);
		assert.equal(facts.sourceMode, 'published');

		// An executor can run the exact attested binary in a VM without replacing its hash.
		const execution = mkdtempSync(path.join(tmpdir(), 'iris-webvm-native-executor-'));
		try {
			const executor = path.join(execution, 'executor');
			const argumentsFile = path.join(execution, 'arguments');
			writeFileSync(executor, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\nexec "$@"\n`);
			chmodSync(executor, 0o755);
			const remoteFacts = inspectNativeFixture({ ...env, NVPN_WEBVM_NATIVE_EXECUTOR: executor });
			assert.equal(remoteFacts.nvpnSha256, facts.nvpnSha256);
			assert.equal(remoteFacts.nvpnVersion, facts.nvpnVersion);
			assert.deepEqual(readFileSync(argumentsFile, 'utf8').trim().split('\n'), [facts.binary, '--version']);
		} finally {
			rmSync(execution, { recursive: true, force: true });
		}

		run('git', ['update-ref', '-d', 'refs/remotes/github/master'], fixture.repository);
		assert.throws(() => inspectNativeFixture(env), /canonical public remote/u);
		const candidateEnv = { ...env, NVPN_WEBVM_NATIVE_SOURCE_MODE: 'candidate' };
		assert.equal(inspectNativeFixture(candidateEnv).sourceMode, 'candidate');
		writeFileSync(fixture.manifest, '[package]\nname = "dirty"\n');
		assert.throws(() => inspectNativeFixture(candidateEnv), /must be clean/u);
	} finally {
		rmSync(fixture.repository, { recursive: true, force: true });
	}
});
