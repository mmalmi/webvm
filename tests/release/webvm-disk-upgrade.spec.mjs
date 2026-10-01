import assert from 'node:assert/strict';
import test from 'node:test';

import { attachWebvmDisk } from '../../src/lib/webvmDisk.js';

const tools = ['/usr/local/bin/nvpn', '/usr/local/bin/htree', '/usr/local/bin/git-remote-htree',
	'/etc/webvm-guest-binaries.sha256'];

function disk(label) {
	const paths = [...tools, '/root/private', '/root/link', '/root/.ash_history',
		'/var/lib/nvpn/.config.toml.nostr-secret-key.secret', '/var/lib/hashtree/config/keys/default'];
	return [paths.map((name, id) => ({
		name, mode: name.endsWith('/link') ? 0o120777 : 0o100600, uid: 123, gid: 456,
		size: id + 1, mtime: 10, ctime: 20, status: 2, sha256sum: `${label}-${id}`,
		links: 2, symlink: name.endsWith('/link') ? '/root/private' : '',
	})), paths, Object.fromEntries(paths.map((name, id) => [id, new Uint8Array([label.charCodeAt(0), id])]))];
}

function filesystem(initial) {
	let state = structuredClone(initial);
	return {
		get inodedata() { return state[2]; },
		SearchPath(name) { return { id: state[1].indexOf(name) }; },
		GetInode(id) { return state[0][id]; },
		get_state() { return structuredClone(state); },
		set_state(value) { state = structuredClone(value); },
	};
}

function storage(t, saved, failPut = false) {
	let record = structuredClone(saved);
	let writes = 0;
	function request(result, complete) {
		const value = new EventTarget();
		value.result = result;
		queueMicrotask(() => {
			value.dispatchEvent(new Event('success'));
			queueMicrotask(() => complete?.());
		});
		return value;
	}
	const database = {
		close() {},
		transaction() {
			const transaction = new EventTarget();
			transaction.objectStore = () => ({
				get: () => request(structuredClone(record), () => transaction.dispatchEvent(new Event('complete'))),
				put(value) {
					return request(undefined, () => {
						if (failPut) {
							transaction.error = new Error('disk transaction aborted');
							transaction.dispatchEvent(new Event('abort'));
							return;
						}
						record = structuredClone(value);
						writes += 1;
						transaction.dispatchEvent(new Event('complete'));
					});
				},
			});
			return transaction;
		},
	};
	for (const [name, value] of Object.entries({
		indexedDB: { open: () => request(database) },
		document: new EventTarget(), addEventListener() {}, removeEventListener() {},
	})) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value });
		t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
	}
	return { record: () => record, writes: () => writes };
}

test('saved guest upgrade replaces every shipped tool while retaining private files and metadata', async (t) => {
	const old = disk('old');
	const fresh = disk('fresh');
	const saved = storage(t, { schema: 1, compatibilityId: 'old', state: old });
	const fs = filesystem(fresh);
	const attached = await attachWebvmDisk({ compatibilityId: 'new', filesystem: fs });
	attached.dispose();
	const result = saved.record();
	assert.equal(saved.writes(), 1);
	assert.equal(result.compatibilityId, 'new');
	for (let id = 0; id < old[0].length; id += 1) {
		const expected = id < tools.length ? fresh : old;
		assert.deepEqual(result.state[0][id], expected[0][id]);
		assert.deepEqual(result.state[2][id], expected[2][id]);
	}
});

test('late missing tool leaves the complete persisted guest unchanged', async (t) => {
	const old = disk('old');
	old[0][2].mode = 0o120777;
	const original = { schema: 2, compatibilityId: 'old', state: old };
	const saved = storage(t, original);
	const fs = filesystem(disk('fresh'));
	t.mock.method(console, 'error', () => {});
	await assert.rejects(attachWebvmDisk({ compatibilityId: 'new', filesystem: fs }), /has not been changed/u);
	assert.equal(saved.writes(), 0);
	assert.deepEqual(saved.record(), original);
});

test('same guest version preserves user tool overrides without another upgrade', async (t) => {
	const old = disk('old');
	const original = { schema: 2, compatibilityId: 'same', state: old };
	const saved = storage(t, original);
	const fs = filesystem(disk('fresh'));
	const attached = await attachWebvmDisk({ compatibilityId: 'same', filesystem: fs });
	attached.dispose();
	assert.equal(saved.writes(), 0);
	assert.deepEqual(fs.get_state(), old);
});

test('failed saved-disk transaction retains the original tools, files and identities', async (t) => {
	const original = { schema: 2, compatibilityId: 'old', state: disk('old') };
	const saved = storage(t, original, true);
	t.mock.method(console, 'error', () => {});
	await assert.rejects(attachWebvmDisk({ compatibilityId: 'new', filesystem: filesystem(disk('fresh')) }),
		/has not been changed/u);
	assert.equal(saved.writes(), 0);
	assert.deepEqual(saved.record(), original);
});
