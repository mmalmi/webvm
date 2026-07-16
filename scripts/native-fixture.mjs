import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function required(env, name) {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function run(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function regularFile(value, name, { executable = false } = {}) {
	const file = path.resolve(value);
	let metadata;
	try {
		metadata = statSync(file);
	} catch {
		throw new Error(`${name} is unavailable: ${file}`);
	}
	if (!metadata.isFile() || (executable && (metadata.mode & 0o111) === 0)) {
		throw new Error(`${name} must be ${executable ? 'an executable' : 'a'} file: ${file}`);
	}
	return realpathSync(file);
}

function section(source, name) {
	const marker = `[${name}]\n`;
	const start = source.indexOf(marker);
	if (start < 0) throw new Error(`Native source is missing [${name}]`);
	const contents = source.slice(start + marker.length);
	const end = contents.search(/^\[/mu);
	return end < 0 ? contents : contents.slice(0, end);
}

function exactDependency(source, name) {
	const line = section(source, 'workspace.dependencies')
		.split('\n')
		.find((candidate) => candidate.trimStart().startsWith(`${name} =`));
	const version = line?.match(/(?:version\s*=\s*)?"=([^"]+)"/u)?.[1];
	if (!version) throw new Error(`${name} must be exactly pinned in native workspace dependencies`);
	return version;
}

function lockRecord(source, name) {
	const block = source.split('[[package]]').slice(1).find(
		(candidate) => candidate.match(/^\s*name\s*=\s*"([^"]+)"/u)?.[1] === name,
	);
	if (!block) throw new Error(`Native Cargo.lock is missing ${name}`);
	const value = (field) => block.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, 'mu'))?.[1];
	const record = {
		version: value('version'),
		source: value('source'),
		checksum: value('checksum'),
	};
	if (record.source !== 'registry+https://github.com/rust-lang/crates.io-index'
		|| !/^[0-9a-f]{64}$/u.test(record.checksum || '')) {
		throw new Error(`${name} must resolve from the checksummed crates.io registry`);
	}
	return record;
}

export function inspectNativeFixture(env = process.env) {
	const binary = regularFile(required(env, 'NVPN_WEBVM_NVPN_BIN'), 'NVPN_WEBVM_NVPN_BIN', {
		executable: true,
	});
	const manifest = regularFile(
		required(env, 'NVPN_APP_CORE_MANIFEST'),
		'NVPN_APP_CORE_MANIFEST',
	);
	const expectedCommit = required(env, 'NVPN_WEBVM_NATIVE_SOURCE_SHA').toLowerCase();
	const expectedFipsVersion = required(env, 'NVPN_WEBVM_FIPS_VERSION');
	if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
		throw new Error('NVPN_WEBVM_NATIVE_SOURCE_SHA must be a full 40-character commit');
	}

	const repository = realpathSync(
		run('git', ['-C', path.dirname(manifest), 'rev-parse', '--show-toplevel']),
	);
	const relativeManifest = path.relative(repository, manifest);
	if (relativeManifest !== 'crates/nostr-vpn-app-core/Cargo.toml') {
		throw new Error(`NVPN_APP_CORE_MANIFEST is not the canonical app-core manifest: ${manifest}`);
	}
	const sourceCommit = run('git', ['-C', repository, 'rev-parse', 'HEAD']).toLowerCase();
	if (sourceCommit !== expectedCommit) {
		throw new Error(`Native source is ${sourceCommit}, expected ${expectedCommit}`);
	}
	if (run('git', ['-C', repository, 'status', '--porcelain', '--untracked-files=all'])) {
		throw new Error(`Native source must be clean at ${expectedCommit}`);
	}
	const publicRefs = run('git', [
		'-C', repository,
		'for-each-ref',
		'--format=%(refname)',
		`--contains=${expectedCommit}`,
		'refs/remotes',
	]).split('\n').filter(Boolean);
	if (!publicRefs.some((ref) => /^refs\/remotes\/(?:github|origin)\/(?:main|master)$/u.test(ref))) {
		throw new Error(`${expectedCommit} is not present on a canonical public remote-tracking branch`);
	}

	const workspaceManifest = readFileSync(path.join(repository, 'Cargo.toml'), 'utf8');
	const workspaceVersion = section(workspaceManifest, 'workspace.package')
		.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
	if (!workspaceVersion) throw new Error('Native workspace version is missing');
	const coreVersion = exactDependency(workspaceManifest, 'fips-core');
	const endpointVersion = exactDependency(workspaceManifest, 'fips-endpoint');
	if (coreVersion !== expectedFipsVersion || endpointVersion !== expectedFipsVersion) {
		throw new Error(`Native source pins FIPS ${coreVersion}/${endpointVersion}, expected ${expectedFipsVersion}`);
	}

	const cargoLock = readFileSync(path.join(repository, 'Cargo.lock'), 'utf8');
	const fipsCore = lockRecord(cargoLock, 'fips-core');
	const fipsEndpoint = lockRecord(cargoLock, 'fips-endpoint');
	if (fipsCore.version !== expectedFipsVersion || fipsEndpoint.version !== expectedFipsVersion) {
		throw new Error('Native Cargo.lock does not resolve the expected FIPS release');
	}
	const nvpnVersion = run(binary, ['--version']).match(/^nvpn\s+([^\s]+)$/u)?.[1];
	if (nvpnVersion !== workspaceVersion) {
		throw new Error(`nVPN binary is ${nvpnVersion || 'unknown'}, expected ${workspaceVersion}`);
	}
	const nvpnSha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');

	return {
		binary,
		manifest,
		repository,
		sourceCommit,
		publicRefs,
		nvpnVersion,
		nvpnSha256,
		fipsCore,
		fipsEndpoint,
	};
}
