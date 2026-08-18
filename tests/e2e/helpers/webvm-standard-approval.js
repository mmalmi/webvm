import { spawn } from 'node:child_process';

import { DEFAULT_FIPS_WEBSOCKET_SEED_URLS } from '../../../src/lib/webvmFipsConfig.js';

import { recipientFromJoinRequest } from './webvm-exit-admin.js';

export function runStandardApproval({
	fixture,
	request,
	dataDir,
	isGuestRosterApplied,
}) {
	return new Promise((resolve, reject) => {
		const timeoutSeconds = Number.parseInt(
			process.env.NVPN_STANDARD_APPROVAL_TIMEOUT_SECS || '90',
			10,
		);
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
			reject(new Error('NVPN_STANDARD_APPROVAL_TIMEOUT_SECS must be a positive integer'));
			return;
		}
		const child = spawn(process.env.CARGO || 'cargo', [
			'run', '--quiet', '--locked', '--manifest-path', fixture.manifest,
			'--example', 'standard_join_approval_e2e', '--',
			'--data-dir', dataDir,
			'--join-request', request,
			'--nvpn-bin', fixture.binary,
			...DEFAULT_FIPS_WEBSOCKET_SEED_URLS.flatMap((url) => [
				'--fips-websocket-seed-url', url,
			]),
			'--timeout-secs', String(timeoutSeconds),
		], {
			cwd: fixture.repository,
			env: {
				...process.env,
				RUSTC_WRAPPER: '',
				RUST_LOG: process.env.NVPN_STANDARD_JOIN_RUST_LOG || 'off',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const events = [];
		let settled = false;
		let checkingGuest = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearInterval(guestPoll);
			callback(value);
		};
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
			finish(reject, new Error(`standard approval helper timed out: ${stderr}`));
		}, (timeoutSeconds + 30) * 1_000);
		const guestPoll = setInterval(async () => {
			if (settled || checkingGuest || !isGuestRosterApplied) return;
			checkingGuest = true;
			try {
				if (await isGuestRosterApplied()) {
					child.kill('SIGTERM');
					const recipient = recipientFromJoinRequest(request);
					finish(resolve, [
						...events,
						{ ok: true, event: 'approved', recipient },
						{ ok: true, event: 'delivered', recipient },
					]);
				}
			} finally {
				checkingGuest = false;
			}
		}, 2_000);
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
			for (;;) {
				const newline = stdout.indexOf('\n');
				if (newline < 0) break;
				const line = stdout.slice(0, newline).trim();
				stdout = stdout.slice(newline + 1);
				if (line) events.push(JSON.parse(line));
			}
		});
		child.stderr.on('data', (chunk) => {
			stderr = `${stderr}${chunk}`.slice(-12_000);
		});
		child.on('error', (error) => finish(reject, error));
		child.on('close', (code, signal) => {
			if (settled) return;
			const stagedWithoutReceipt = code === 1 && !signal
				&& events.some((event) => event.ok === true && event.event === 'approved')
				&& events.some((event) => event.ok === false && event.event === 'error');
			if (stagedWithoutReceipt) {
				finish(resolve, events);
				return;
			}
			if (code !== 0 || signal) {
				finish(reject, new Error(
					`standard approval helper exited ${signal || code}: ${stderr}`
					+ `\n${events.map((event) => JSON.stringify(event)).join('\n')}`,
				));
				return;
			}
			finish(resolve, events);
		});
	});
}
