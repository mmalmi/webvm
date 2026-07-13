const DATABASE_NAME = 'iris-webvm';
const DATABASE_VERSION = 1;
const DISK_RECORD_SCHEMA = 2;
const PORTABLE_FILE_PATHS = [
	'/root/.ash_history',
	'/var/lib/nvpn/config.toml',
	'/var/lib/nvpn/.config.toml.nostr-secret-key.secret',
	'/var/lib/nvpn/.config.toml.pending-join-request.secret',
	'/var/lib/nvpn/.config.toml.wireguard-exit-peer-preshared-key.secret',
	'/var/lib/nvpn/.config.toml.wireguard-exit-private-key.secret',
	'/var/lib/nvpn/config.toml.join-approval-ack',
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

async function clearRecord() {
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

async function readPortableFiles(filesystem) {
	if (!filesystem?.SearchPath || !filesystem?.GetInode || !filesystem?.Read) return {};
	const files = {};
	for (const filePath of PORTABLE_FILE_PATHS) {
		const location = filesystem.SearchPath(filePath);
		if (!location || location.id < 0) continue;
		const inode = filesystem.GetInode(location.id);
		const data = await filesystem.Read(location.id, 0, inode.size);
		if (data) files[filePath] = new Uint8Array(data);
	}
	return files;
}

async function restorePortableFiles(filesystem, files) {
	if (!files || !filesystem?.SearchPath || !filesystem?.GetInode
		|| !filesystem?.CreateFile || !filesystem?.ChangeSize || !filesystem?.Write) return;
	for (const filePath of PORTABLE_FILE_PATHS) {
		const data = files[filePath];
		if (!(data instanceof Uint8Array)) continue;
		let location = filesystem.SearchPath(filePath);
		if (location.id < 0) {
			const separator = filePath.lastIndexOf('/');
			const parent = filesystem.SearchPath(filePath.slice(0, separator));
			if (parent.id < 0) continue;
			const id = filesystem.CreateFile(filePath.slice(separator + 1), parent.id);
			location = { id };
		}
		await filesystem.ChangeSize(location.id, data.byteLength);
		await filesystem.Write(location.id, 0, data.byteLength, data);
	}
}

async function recoverPortableFilesFromState(filesystem, state) {
	if (!state) return {};
	const freshState = serializableFilesystemState(filesystem);
	try {
		filesystem.set_state(state);
		return await readPortableFiles(filesystem);
	} catch (error) {
		console.warn('Could not recover portable files from the previous WebVM disk', error);
		return {};
	} finally {
		filesystem.set_state(freshState);
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
		if ([1, DISK_RECORD_SCHEMA].includes(record?.schema)
			&& record.compatibilityId === compatibilityId) {
			filesystem.set_state(record.state);
		} else if ([1, DISK_RECORD_SCHEMA].includes(record?.schema)) {
			const recoveredFiles = await recoverPortableFilesFromState(filesystem, record.state);
			await restorePortableFiles(filesystem, {
				...recoveredFiles,
				...record.portableFiles,
			});
		}
		void navigator.storage?.persist?.().catch(() => false);
		await publishReadyStatus();
	} catch (error) {
		console.error('WebVM local disk is unavailable', error);
		onStatus?.('unavailable');
		return null;
	}

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
		const portableFiles = await readPortableFiles(filesystem);
		saveTask = saveTask.then(async () => {
			await saveRecord({
				schema: DISK_RECORD_SCHEMA,
				compatibilityId,
				state,
				portableFiles,
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
			await clearRecord();
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
