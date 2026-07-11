function findEntry(entries, segments) {
	let children = entries;
	let entry;
	for (const segment of segments) {
		entry = children?.find((candidate) => candidate?.[0] === segment);
		if (!entry) return null;
		children = Array.isArray(entry[6]) ? entry[6] : null;
	}
	return entry;
}

export async function preloadV86GuestFile({
	filesystemUrl,
	rootfsUrl,
	guestPath,
	fetchImpl = fetch,
} = {}) {
	const segments = String(guestPath || '').split('/').filter(Boolean);
	if (segments.length === 0) throw new TypeError('A guest file path is required');
	const filesystemResponse = await fetchImpl(filesystemUrl);
	if (!filesystemResponse.ok) {
		throw new Error(`Failed to load WebVM filesystem manifest (${filesystemResponse.status})`);
	}
	const filesystem = await filesystemResponse.json();
	const entry = findEntry(filesystem?.fsroot, segments);
	const blob = entry?.[6];
	if (typeof blob !== 'string' || blob.startsWith('/')) {
		throw new Error(`WebVM guest file is not preloadable: ${guestPath}`);
	}
	const response = await fetchImpl(new URL(blob, new URL(rootfsUrl, filesystemResponse.url)));
	if (!response.ok) throw new Error(`Failed to preload WebVM guest file (${response.status})`);
	await response.arrayBuffer();
}
