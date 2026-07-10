import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const GUEST_MANIFEST_SCHEMA = 'iris-webvm-v86-guest/v1';

export async function hashFile(filePath) {
	const contents = await readFile(filePath);
	return createHash('sha256').update(contents).digest('hex');
}

export async function fileRecord(filePath) {
	const metadata = await stat(filePath);
	if (!metadata.isFile()) {
		throw new Error(`Expected file: ${filePath}`);
	}
	return {
		sha256: await hashFile(filePath),
		bytes: metadata.size,
	};
}

export async function treeRecord(directory) {
	const records = [];
	await walk(directory, '', records);
	const digest = createHash('sha256');
	let bytes = 0;
	for (const record of records) {
		digest.update(record.relativePath);
		digest.update('\0');
		digest.update(String(record.bytes));
		digest.update('\0');
		digest.update(record.sha256);
		digest.update('\n');
		bytes += record.bytes;
	}
	return {
		sha256: digest.digest('hex'),
		files: records.length,
		bytes,
	};
}

async function walk(directory, relativeDirectory, records) {
	const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const relativePath = path.posix.join(relativeDirectory, entry.name);
		if (entry.isDirectory()) {
			await walk(directory, relativePath, records);
			continue;
		}
		if (!entry.isFile()) {
			throw new Error(`Unsupported guest artifact entry: ${relativePath}`);
		}
		records.push({ relativePath, ...(await fileRecord(path.join(directory, relativePath))) });
	}
}

export function gitRecord(repository) {
	const commit = git(repository, ['rev-parse', 'HEAD']);
	const dirty = git(repository, ['status', '--porcelain', '--untracked-files=all']).length > 0;
	return { commit, dirty };
}

export function gitCommit(repository) {
	return git(repository, ['rev-parse', 'HEAD']);
}

function git(repository, args) {
	return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}
