import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.svelte']);
const MAX_SOURCE_LINES = 500;
const MAX_SOURCE_BYTES = 256 * 1024;

function trackedFiles(patterns) {
	const output = execFileSync('git', ['ls-files', '-z', '--', ...patterns], {
		cwd: ROOT,
		encoding: 'utf8',
	});
	return output
		.split('\0')
		.filter(Boolean)
		.filter((file) => existsSync(path.join(ROOT, file)));
}

const sourceFiles = trackedFiles([
	'src/**',
	'tests/**',
	'scripts/**',
]).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
const failures = [];

for (const file of sourceFiles) {
	const absolute = path.join(ROOT, file);
	const source = readFileSync(absolute, 'utf8');
	const lines = source === '' ? 0 : source.split('\n').length;
	if (lines > MAX_SOURCE_LINES) {
		failures.push(`${file}: ${lines} lines exceeds the ${MAX_SOURCE_LINES}-line limit`);
	}
	if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
		failures.push(`${file}: exceeds the ${MAX_SOURCE_BYTES}-byte source limit`);
	}
	if (/\r/u.test(source)) failures.push(`${file}: contains CRLF/CR line endings`);
	if (/[ \t]+$/mu.test(source)) failures.push(`${file}: contains trailing whitespace`);
	if (/\bdebugger\s*;/u.test(source)) failures.push(`${file}: contains a debugger statement`);
	if (/\beval\s*\(/u.test(source)) failures.push(`${file}: uses dynamic code evaluation`);
}

for (const file of sourceFiles.filter((file) => ['.js', '.mjs'].includes(path.extname(file)))) {
	try {
		execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
	} catch (error) {
		failures.push(`${file}: JavaScript syntax check failed\n${error.stderr?.toString() || ''}`);
	}
}

for (const file of trackedFiles(['scripts/*.sh', 'dockerfiles/*.sh', 'dockerfiles/*.openrc'])) {
	try {
		execFileSync('/bin/sh', ['-n', path.join(ROOT, file)], { stdio: 'pipe' });
	} catch (error) {
		failures.push(`${file}: shell syntax check failed\n${error.stderr?.toString() || ''}`);
	}
}

if (failures.length > 0) {
	console.error(`Source quality checks failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
	process.exitCode = 1;
} else {
	console.log(`Source quality checks passed (${sourceFiles.length} JS/TS/Svelte files).`);
}
