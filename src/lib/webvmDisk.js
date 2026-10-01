const DATABASE_NAME = 'iris-webvm';
const DATABASE_VERSION = 1;
const DISK_RECORD_SCHEMA = 2;
const SYSTEM_UPDATE_PATHS = [
	...Object.values(WEBVM_GUEST_TOOLS), WEBVM_GUEST_CHECKSUMS,
];
const RECORD_KEY = 'root-filesystem';
const SAVE_DELAY_MS = 1_000;
const STORE_NAME = 'disks';

function requestToPromise(request) {
	return new Promise((resolve, reject) => {
		request.addEventListener('success', () => resolve(request.result), { once: true });
		request.addEventListener('error', () => reject(request.error), { once: true });
	});
}

async function openDatabase() {
	const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
	request.addEventListener('upgradeneeded', () => {
		if (!request.result.objectStoreNames.contains(STORE_NAME)) {
			request.result.createObjectStore(STORE_NAME);
		}
	}, { once: true });
	return requestToPromise(request);
}

async function runTransaction(mode, operation) {
	const database = await openDatabase();
	try {
		const transaction = database.transaction(STORE_NAME, mode);
		const completed = new Promise((resolve, reject) => {
			transaction.addEventListener('complete', resolve, { once: true });
			transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
			transaction.addEventListener('error', () => reject(transaction.error), { once: true });
		});
		const result = await operation(transaction.objectStore(STORE_NAME));
		await completed;
		return result;
	} finally {
		database.close();
	}
}

async function loadRecord() {
	return runTransaction('readonly', (store) => requestToPromise(store.get(RECORD_KEY)));
}

async function saveRecord(record) {
	await runTransaction('readwrite', (store) => requestToPromise(store.put(record, RECORD_KEY)));
}

export async function clearWebvmDisk() {
	await runTransaction('readwrite', (store) => requestToPromise(store.delete(RECORD_KEY)));
}

async function indexedDbUsageBytes() {
	try {
		const estimate = await navigator.storage?.estimate?.();
		const bytes = estimate?.usageDetails?.indexedDB;
		return Number.isFinite(bytes) ? bytes : null;
	} catch {
		return null;
	}
}

function serializableFilesystemState(filesystem) {
	const state = filesystem.get_state();
	if (!Array.isArray(state[0])) return state;
	if (state.length > 5) throw new Error('Mounted 9p filesystems cannot be persisted safely');
	state[0] = state[0].map((inode) => {
		if (!inode?.get_state) return inode;
		const inodeState = inode.get_state();
		inodeState[2] = inodeState[2].map((lock) => lock?.get_state?.() ?? lock);
		return inodeState;
	});
	return state;
}

function systemFile(filesystem, filePath) {
	const { id } = filesystem.SearchPath(filePath);
	const inode = id >= 0 && filesystem.GetInode(id);
	if (!inode || (inode.mode & 0o170000) !== 0o100000) {
		throw new Error(`Missing regular system file: ${filePath}`);
	}
	return { id, inode };
}

function upgradeFilesystem(filesystem, state) {
	// Restore the complete disk, including links, permissions and service keys.
	// Replace only the shipped tools and their receipt. Keep their fresh
	// content-addressed backing so the binaries are still loaded on demand.
	const updates = SYSTEM_UPDATE_PATHS.map((filePath) => {
		const { id, inode } = systemFile(filesystem, filePath);
		const metadata = Object.fromEntries([
			'mode', 'uid', 'gid', 'size', 'mtime', 'ctime', 'status', 'sha256sum',
		].map((name) => [name, inode[name]]));
		return { filePath, metadata, data: filesystem.inodedata[id]?.slice() };
	});
	filesystem.set_state(state);
	for (const { filePath, metadata, data } of updates) {
		const { id, inode } = systemFile(filesystem, filePath);
		Object.assign(inode, metadata);
		if (data) filesystem.inodedata[id] = data;
		else delete filesystem.inodedata[id];
	}
}

export async function attachWebvmDisk({ compatibilityId, filesystem, onStatus }) {
	if (!globalThis.indexedDB || !filesystem?.get_state || !filesystem?.set_state) {
		onStatus?.('unavailable');
		return null;
	}

	let changeVersion = 0;
	let disposed = false;
	let saveTimer = null;
	let saveTask = Promise.resolve();
	const originalNotifyListeners = filesystem.NotifyListeners;
	const publishReadyStatus = async () => onStatus?.('ready', await indexedDbUsageBytes());

	try {
		const record = await loadRecord();
		if (record) {
			if (![1, DISK_RECORD_SCHEMA].includes(record.schema)) {
				throw new Error('Unsupported saved disk format');
			}
			if (record.compatibilityId === compatibilityId) filesystem.set_state(record.state);
			else {
				upgradeFilesystem(filesystem, record.state);
				// Commit only after the full restore and every system update succeeds.
				await saveRecord({
					schema: DISK_RECORD_SCHEMA, compatibilityId,
					state: serializableFilesystemState(filesystem),
				});
			}
		}
	} catch (error) {
		console.error('WebVM local disk is unavailable', error);
		onStatus?.('unavailable');
		throw new Error('Your saved disk could not be restored. It has not been changed.', { cause: error });
	}
	void navigator.storage?.persist?.().catch(() => false);
	await publishReadyStatus();

	function scheduleSave() {
		if (disposed || saveTimer) return;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			void flush();
		}, SAVE_DELAY_MS);
	}

	async function flush() {
		if (disposed || changeVersion === 0) return saveTask;
		const version = changeVersion;
		const state = serializableFilesystemState(filesystem);
		saveTask = saveTask.then(async () => {
			await saveRecord({
				schema: DISK_RECORD_SCHEMA,
				compatibilityId,
				state,
			});
			await publishReadyStatus();
			if (changeVersion === version) changeVersion = 0;
			else scheduleSave();
		}).catch((error) => {
			console.error('Failed to save the WebVM local disk', error);
			onStatus?.('error');
		});
		return saveTask;
	}

	filesystem.NotifyListeners = function notifyAndPersist(...args) {
		const result = originalNotifyListeners?.apply(this, args);
		changeVersion += 1;
		scheduleSave();
		return result;
	};

	const saveBeforeLeaving = () => void flush();
	const saveWhenHidden = () => {
		if (document.visibilityState === 'hidden') void flush();
	};
	globalThis.addEventListener('pagehide', saveBeforeLeaving);
	document.addEventListener('visibilitychange', saveWhenHidden);

	return {
		async reset() {
			disposed = true;
			if (saveTimer) clearTimeout(saveTimer);
			await saveTask;
			await clearWebvmDisk();
		},
		flush,
		dispose() {
			void flush();
			disposed = true;
			if (saveTimer) clearTimeout(saveTimer);
			filesystem.NotifyListeners = originalNotifyListeners;
			globalThis.removeEventListener('pagehide', saveBeforeLeaving);
			document.removeEventListener('visibilitychange', saveWhenHidden);
		},
	};
}
import { WEBVM_GUEST_CHECKSUMS, WEBVM_GUEST_TOOLS } from './webvmGuestTools.js';
