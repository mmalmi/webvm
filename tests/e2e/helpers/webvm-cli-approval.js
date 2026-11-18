import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { nativeCommand } from '../../../scripts/native-fixture.mjs';
import { DEFAULT_FIPS_WEBSOCKET_SEED_URLS } from '../../../src/lib/webvmFipsConfig.js';
import { normalizedPubkey, recipientFromJoinRequest } from './webvm-exit-admin.js';

const execute = promisify(execFile);

export function supportsCliApproval(binary) {
	const result = spawnSync(...nativeCommand(binary, ['join-requests', 'approve', '--help']), {
		encoding: 'utf8', timeout: 15_000,
	});
	if (result.error) throw result.error;
	if (result.status === 0) return true;
	if (/unrecognized subcommand/u.test(result.stderr)) return false;
	throw new Error('Could not inspect the native join approval command');
}

export async function approveWithCli({
	binary, adminConfig, dataDir, request, waitUntil, guestApplied, timeoutMs,
	seedUrls = DEFAULT_FIPS_WEBSOCKET_SEED_URLS,
}) {
	const config = adminConfig || path.join(dataDir, 'config.toml');
	const cli = async (args) => {
		const { stdout } = await execute(...nativeCommand(binary, [...args, '--config', config]), {
			encoding: 'utf8', timeout: 120_000,
		});
		return stdout;
	};
	const recipient = recipientFromJoinRequest(request);
	const requestFile = path.join(dataDir, 'join-request.txt');
	await writeFile(requestFile, request, { mode: 0o600, flag: 'wx' });
	let daemon;
	let closed;
	let spawnError;
	let daemonError = '';
	const checkDaemon = () => {
		if (spawnError) throw spawnError;
		if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) {
			const reason = daemonError.replace(/nvpn:\/\/\S+|(?:npub|nsec)1[a-z0-9]+|\b[0-9a-f]{64}\b/giu, '[redacted]').trim();
			throw new Error(`Isolated approval daemon exited with ${daemon.signalCode || daemon.exitCode}\n${reason}`);
		}
	};
	try {
		if (!adminConfig) {
			if (!existsSync(config)) {
				await cli(['init']);
				const { device_id: owner } = JSON.parse(await cli(['status', '--json']));
				await cli(['set', '--device', normalizedPubkey(owner)]);
			}
			const args = ['daemon', '--config', config, '--paused'];
			if (process.platform === 'linux') args.push('--iface', 'wvm' + randomBytes(4).toString('hex'));
			for (const url of seedUrls) args.push('--fips-websocket-seed-url', url);
			daemon = spawn(...nativeCommand(binary, args), { stdio: ['ignore', 'ignore', 'pipe'] });
			daemon.stderr.on('data', (chunk) => { daemonError = (daemonError + chunk).slice(-2048); });
			daemon.once('error', (error) => { spawnError = error; });
			closed = new Promise((resolve) => daemon.once('close', resolve));
		}
		await waitUntil(async () => {
			checkDaemon();
			return JSON.parse(await cli(['status', '--json'])).daemon?.running === true;
		}, { timeoutMs: 30_000, intervalMs: 250, message: 'Native approval daemon did not start' });
		const approval = JSON.parse(await cli([
			'join-requests', 'approve', '--request-file', requestFile, '--json',
		]));
		if (approval.approved !== true || approval.delivery !== 'queued'
			|| normalizedPubkey(approval.device_id) !== recipient
			|| !/^[0-9a-f]{64}$/u.test(approval.roster_event_id)) {
			throw new Error('Native CLI did not queue a signed roster for the requested device');
		}
		await waitUntil(() => {
			checkDaemon();
			return guestApplied();
		}, { timeoutMs, intervalMs: 2_000, message: 'Guest did not apply the signed roster queued by the native CLI' });
		return [
			{ ok: true, event: 'approved', recipient, rosterEventId: approval.roster_event_id },
			{ ok: true, event: 'delivered', recipient },
		];
	} finally {
		if (daemon) {
			daemon.kill('SIGTERM');
			const forceStop = setTimeout(() => daemon.kill('SIGKILL'), 10_000);
			try {
				await closed;
			} finally {
				clearTimeout(forceStop);
			}
		}
	}
}
