export const WEBVM_ROOTFS_PATH = '/v86/guest/rootfs/';

export function shardedWebvmRootfsPath(pathname) {
	if (!pathname.startsWith(WEBVM_ROOTFS_PATH)) return null;
	const filename = pathname.slice(WEBVM_ROOTFS_PATH.length);
	if (!/^[0-9a-f]{8}\.bin\.zst$/u.test(filename)) return null;
	// Two levels of 16 directories stay below Hashtree's directory fanout
	// threshold, even when all 256 two-digit prefixes occur.
	return `${WEBVM_ROOTFS_PATH}${filename[0]}/${filename[1]}/${filename}`;
}

export function isWebvmRootfsPath(pathname) {
	const flat = WEBVM_ROOTFS_PATH + pathname.slice(pathname.lastIndexOf('/') + 1);
	const sharded = shardedWebvmRootfsPath(flat);
	return !!sharded && (pathname === flat || pathname === sharded);
}
