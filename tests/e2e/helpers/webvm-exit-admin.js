import { execFile, execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { nip19 } from 'nostr-tools';

const LAUNCHD_LABEL = 'system/to.nostrvpn.nvpn';
const LAUNCHD_PLIST = '/Library/LaunchDaemons/to.nostrvpn.nvpn.plist';

export function normalizedPubkey(value) {
	if (/^[0-9a-f]{64}$/u.test(value)) return value;
	const decoded = nip19.decode(value);
	if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
		throw new Error('exit admin status returned an invalid device ID');
	}
	return decoded.data;
}

export function stageExitAdminConfig(sourceConfig, dataDir) {
	const config = path.resolve(sourceConfig);
	copyFileSync(config, path.join(dataDir, 'config.toml'));
	for (const name of readdirSync(path.dirname(config))) {
		if (/^\.config\.toml\..+\.secret$/u.test(name)) {
			copyFileSync(path.join(path.dirname(config), name), path.join(dataDir, name));
		}
	}
}

export async function prepareLiveExitApproval({ fixture }) {
	const target = path.resolve(fixture.repository, process.env.CARGO_TARGET_DIR || 'target');
	const crate = path.join(target, 'webvm-live-exit-approval', fixture.sourceCommit);
	const source = path.join(crate, 'src');
	mkdirSync(source, { recursive: true });
	const writeChanged = (file, contents) => {
		if (!existsSync(file) || readFileSync(file, 'utf8') !== contents) {
			writeFileSync(file, contents, { mode: 0o600 });
		}
	};
	writeChanged(path.join(crate, 'Cargo.toml'), [
		'[package]',
		'name = "iris-webvm-live-exit-approval"',
		'version = "0.0.0"',
		'edition = "2024"',
		'',
		'[workspace]',
		'',
		'[dependencies]',
		`nostr-vpn-app-core = { path = ${JSON.stringify(path.join(
			fixture.repository,
			'crates/nostr-vpn-app-core',
		))} }`,
		'',
	].join('\n'));
	writeChanged(
		path.join(source, 'main.rs'),
		readFileSync(path.resolve('tests/fixtures/stage-live-join-approval.rs'), 'utf8'),
	);
	// Reuse the verified native dependency versions instead of resolving a fresh graph.
	const lock = path.join(crate, 'Cargo.lock');
	if (!existsSync(lock)) copyFileSync(path.join(fixture.repository, 'Cargo.lock'), lock);
	const { stdout } = await promisify(execFile)(process.env.CARGO || 'cargo', [
		'build', '--quiet', '--message-format=json-render-diagnostics',
		'--target-dir', target,
		'--manifest-path', path.join(crate, 'Cargo.toml'),
	], {
		cwd: fixture.repository,
		encoding: 'utf8',
		env: { ...process.env, RUSTC_WRAPPER: '' },
		timeout: 600_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	const artifact = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
		.find((entry) => entry.reason === 'compiler-artifact'
			&& entry.target?.name === 'iris-webvm-live-exit-approval'
			&& entry.target.kind.includes('bin') && entry.executable);
	const metadata = artifact && statSync(artifact.executable);
	if (!metadata?.isFile() || (metadata.mode & 0o111) === 0) {
		throw new Error('Cargo did not produce an executable live-exit approval helper');
	}
	const prepared = path.join(crate, 'bin', path.basename(artifact.executable));
	mkdirSync(path.dirname(prepared), { recursive: true });
	copyFileSync(artifact.executable, prepared);
	console.log('Native approval helper ready');
	return prepared;
}

export function stageLiveExitApproval({ approvalBinary, nvpnBinary, request, config }) {
	return execFileSync(approvalBinary, [config, request, nvpnBinary], {
		encoding: 'utf8',
		timeout: 120_000,
	}).trim();
}

export function recipientFromJoinRequest(request) {
	const encoded = request.slice('nvpn://join-request/'.length);
	const bootstrap = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	return normalizedPubkey(bootstrap.deviceAppKeyNpub);
}

function joinOutbox(config) {
	return path.join(path.dirname(config), `${path.basename(config)}.join-roster-outbox`);
}

export function snapshotOutbox(config) {
	try {
		return new Set(readdirSync(joinOutbox(config)));
	} catch (error) {
		if (error?.code === 'ENOENT') return new Set();
		throw error;
	}
}

export function removeNewOutboxEntries(config, previous) {
	const directory = joinOutbox(config);
	let entries;
	try {
		entries = readdirSync(directory);
	} catch (error) {
		if (error?.code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		if (!previous.has(entry)) rmSync(path.join(directory, entry));
	}
	if (previous.size === 0) {
		try {
			rmdirSync(directory);
		} catch (error) {
			if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
		}
	}
}

export function runExitAdmin(binary, config, args) {
	return execFileSync(binary, [...args, '--config', config], {
		encoding: 'utf8',
		timeout: 30_000,
	}).trim();
}

export function exitAdminStatus(binary, config) {
	return JSON.parse(runExitAdmin(binary, config, ['status', '--json']));
}

function runLaunchctl(args) {
	return execFileSync('/usr/bin/sudo', ['-n', '/bin/launchctl', ...args], {
		encoding: 'utf8',
		timeout: 30_000,
	}).trim();
}

function exitAdminServiceLoaded() {
	try {
		execFileSync('/bin/launchctl', ['print', LAUNCHD_LABEL], {
			stdio: 'ignore',
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

export function stopExitAdminService() {
	runLaunchctl(['bootout', 'system', LAUNCHD_PLIST]);
}

export function startExitAdminService() {
	if (!exitAdminServiceLoaded()) runLaunchctl(['bootstrap', 'system', LAUNCHD_PLIST]);
	runLaunchctl(['kickstart', '-k', LAUNCHD_LABEL]);
}
