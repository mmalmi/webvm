import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	prepareLiveExitApproval,
	stageLiveExitApproval,
} from '../e2e/helpers/webvm-exit-admin.js';

test('live approval builds with pinned dependencies before running the prepared executable', async (t) => {
	const directory = mkdtempSync(path.join(tmpdir(), 'webvm-approval-'));
	const repository = path.join(directory, 'native');
	const cargo = path.join(directory, 'cargo.cjs');
	const executable = path.join(directory, 'approval');
	const buildArguments = path.join(directory, 'build.json');
	const previousCargo = process.env.CARGO;
	const previousTarget = process.env.CARGO_TARGET_DIR;
	const previousExecutor = process.env.NVPN_WEBVM_NATIVE_EXECUTOR;
	t.after(() => {
		if (previousCargo === undefined) delete process.env.CARGO;
		else process.env.CARGO = previousCargo;
		if (previousTarget === undefined) delete process.env.CARGO_TARGET_DIR;
		else process.env.CARGO_TARGET_DIR = previousTarget;
		if (previousExecutor === undefined) delete process.env.NVPN_WEBVM_NATIVE_EXECUTOR;
		else process.env.NVPN_WEBVM_NATIVE_EXECUTOR = previousExecutor;
		rmSync(directory, { recursive: true, force: true });
	});
	mkdirSync(repository);
	writeFileSync(path.join(repository, 'Cargo.lock'), '# pinned native dependency graph\n');
	writeFileSync(executable, `#!${process.execPath}\n` +
		'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
	writeFileSync(cargo, `#!${process.execPath}\n` +
		`require('node:fs').writeFileSync(${JSON.stringify(buildArguments)}, ` +
		'JSON.stringify(process.argv.slice(2)));\n' +
		`console.log(${JSON.stringify(JSON.stringify({
			reason: 'compiler-artifact',
			target: { name: 'iris-webvm-live-exit-approval', kind: ['bin'] },
			executable,
		}))});\n`, { mode: 0o755 });
	delete process.env.NVPN_WEBVM_NATIVE_EXECUTOR;
	process.env.CARGO = cargo;
	process.env.CARGO_TARGET_DIR = path.join(directory, 'target');
	const fixture = { repository, binary: '/fixture/nvpn', sourceCommit: 'a'.repeat(40) };
	const approvalBinary = await prepareLiveExitApproval({ fixture });
	assert.notEqual(approvalBinary, executable);
	const args = JSON.parse(readFileSync(buildArguments, 'utf8'));
	assert.equal(args[0], 'build');
	assert.ok(args.includes('--message-format=json-render-diagnostics'));
	const manifest = args[args.indexOf('--manifest-path') + 1];
	assert.equal(readFileSync(path.join(path.dirname(manifest), 'Cargo.lock'), 'utf8'),
		'# pinned native dependency graph\n');
	await prepareLiveExitApproval({ fixture });
	assert.deepEqual(JSON.parse(readFileSync(buildArguments, 'utf8')), args);

	// Approval must work without Cargo; its operation deadline cannot include a rebuild.
	rmSync(cargo);
	writeFileSync(executable, `#!${process.execPath}\nprocess.exit(42);\n`);
	const request = 'nvpn://join-request/test-request';
	const exitBinary = '/fixture/exit-wrapper';
	const result = stageLiveExitApproval({
		approvalBinary, nvpnBinary: exitBinary, request, config: '/fixture/config.toml',
	});
	assert.deepEqual(JSON.parse(result), ['/fixture/config.toml', request, exitBinary]);

	writeFileSync(cargo, `#!${process.execPath}\n` +
		'console.error("native helper compilation failed"); process.exit(1);\n', { mode: 0o755 });
	await assert.rejects(prepareLiveExitApproval({ fixture }), /native helper compilation failed/u);
});
