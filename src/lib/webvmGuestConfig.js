// Leave room for the native networking services and package downloads without
// forcing the guest kernel to reclaim executable pages on every request.
export const WEBVM_MEMORY_BYTES = 256 * 1024 * 1024;
