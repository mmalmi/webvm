<script>
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import { createWebvmFipsHost } from '$lib/webvmFipsHost.js';
	import '$lib/global.css';
	import '@xterm/xterm/css/xterm.css';

	const BIOS_URL = '/v86/seabios.bin';
	const VGA_BIOS_URL = '/v86/vgabios.bin';
	const V86_WASM_URL = '/v86/v86.wasm';
	const GUEST_FS_URL = '/v86/guest/fs.json';
	const GUEST_ROOTFS_URL = '/v86/guest/rootfs/';
	const SERIAL_BUFFER_LIMIT = 128 * 1024;

	let destroyed = false;
	let screenContainer;
	let serialConsole;
	let serialTerminal = null;
	let serialInputDisposable = null;
	let emulator = null;
	let fipsHost = null;
	let vmState = 'loading';
	let vmSummary = 'Loading WebVM';
	let vmError = '';
	let fipsStatus = {
		state: 'waiting-vm',
		error: '',
		lastPeerError: '',
		ethernetPeers: 0,
		webrtcPeers: 0,
	};
	let removeEmulatorListeners = [];

	function messageFromError(error) {
		return error instanceof Error ? error.message : String(error || 'Unknown error');
	}

	function addEmulatorListener(instance, event, handler) {
		instance?.add_listener?.(event, handler);
		return () => instance?.remove_listener?.(event, handler);
	}

	function installEmulatorListeners(instance) {
		const serialDecoder = new TextDecoder();
		let serialText = '';
		removeEmulatorListeners = [
			addEmulatorListener(instance, 'emulator-loaded', () => {
				vmState = 'loaded';
				vmSummary = 'WebVM loaded';
				publishDebugState();
			}),
			addEmulatorListener(instance, 'emulator-ready', () => {
				vmState = 'ready';
				vmSummary = 'WebVM ready';
				publishDebugState();
			}),
			addEmulatorListener(instance, 'emulator-started', () => {
				vmState = 'running';
				vmSummary = 'WebVM running';
				publishDebugState();
			}),
			addEmulatorListener(instance, 'download-error', (event) => {
				vmState = 'load-failed';
				vmError = `Failed to load ${event?.file_name || 'WebVM asset'}`;
				vmSummary = vmError;
				publishDebugState();
			}),
			addEmulatorListener(instance, 'serial0-output-byte', (byte) => {
				const text = serialDecoder.decode(Uint8Array.of(byte & 0xff), { stream: true });
				if (!text) return;
				serialText += text;
				if (serialText.length > SERIAL_BUFFER_LIMIT) {
					serialText = serialText.slice(-SERIAL_BUFFER_LIMIT);
				}
				serialTerminal?.write(text);
			}),
		];
	}

	async function initializeSerialTerminal() {
		const { Terminal } = await import('@xterm/xterm');
		if (destroyed) return;
		serialTerminal = new Terminal({
			cols: 120,
			rows: 32,
			convertEol: true,
			cursorBlink: true,
			fontFamily: 'Menlo, Monaco, Consolas, monospace',
			fontSize: 12,
			letterSpacing: 0,
			scrollback: 5_000,
			theme: {
				background: '#020617',
				foreground: '#d1fae5',
			},
		});
		serialTerminal.open(serialConsole);
		serialInputDisposable = serialTerminal.onData((data) => emulator?.serial0_send?.(data));
		publishDebugState();
	}

	function getTestHooks() {
		return localDiagnosticsEnabled() ? globalThis.irisWebvmV86TestHooks || null : null;
	}

	function localDiagnosticsEnabled() {
		if (!browser) return false;
		return ['127.0.0.1', 'localhost', '[::1]'].includes(globalThis.location.hostname);
	}

	async function createV86Instance(options) {
		const hook = getTestHooks()?.createV86;
		if (hook) return hook(options);
		const { V86 } = await import('v86');
		return new V86(options);
	}

	async function startFipsHost(instance) {
		const hook = getTestHooks()?.createFipsHost;
		const createHost = hook || createWebvmFipsHost;
		fipsHost = await createHost({
			emulator: instance,
			onStatus(status) {
				fipsStatus = status;
				publishDebugState();
			},
		});
	}

	async function bootV86() {
		vmState = 'loading';
		vmSummary = 'Loading WebVM';
		vmError = '';
		const rawSerialConsole = document.createElement('textarea');
		const options = {
			wasm_path: V86_WASM_URL,
			memory_size: 256 * 1024 * 1024,
			vga_memory_size: 8 * 1024 * 1024,
			autostart: true,
			fastboot: true,
			disable_speaker: true,
			bios: { url: BIOS_URL },
			vga_bios: { url: VGA_BIOS_URL },
			bzimage_initrd_from_filesystem: true,
			cmdline: 'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci console=ttyS0 console=tty0 loglevel=3',
			filesystem: {
				baseurl: GUEST_ROOTFS_URL,
				basefs: GUEST_FS_URL,
			},
			screen: {
				container: screenContainer,
				use_graphical_text: true,
			},
			serial_container: rawSerialConsole,
			net_device: {
				type: 'virtio',
				id: 0,
				mtu: 1500,
			},
		};

		try {
			const instance = await createV86Instance(options);
			if (destroyed) {
				await instance?.destroy?.();
				return;
			}
			emulator = instance;
			installEmulatorListeners(instance);
			vmState = 'created';
			vmSummary = 'WebVM initialized';
			publishDebugState();
			try {
				await startFipsHost(instance);
			} catch (error) {
				fipsStatus = {
					...fipsStatus,
					state: 'failed',
					error: messageFromError(error),
				};
				publishDebugState();
			}
		} catch (error) {
			vmState = 'load-failed';
			vmError = messageFromError(error);
			vmSummary = vmError || 'WebVM failed to load';
			publishDebugState();
		}
	}

	function publishDebugState() {
		if (!localDiagnosticsEnabled()) return;
		globalThis.irisWebvmV86 = {
			emulator,
			fipsHost,
			serialTerminal,
			state: () => ({
				vmState,
				vmSummary,
				vmError,
				fipsStatus,
			}),
		};
	}

	onMount(() => {
		publishDebugState();
		void initializeSerialTerminal().then(() => bootV86());
	});

	onDestroy(() => {
		destroyed = true;
		for (const removeListener of removeEmulatorListeners) removeListener?.();
		removeEmulatorListeners = [];
		serialInputDisposable?.dispose?.();
		serialInputDisposable = null;
		serialTerminal?.dispose?.();
		serialTerminal = null;
		void fipsHost?.stop?.();
		void emulator?.destroy?.();
		if (localDiagnosticsEnabled()) delete globalThis.irisWebvmV86;
	});
</script>

<svelte:head>
	<title>Iris WebVM</title>
</svelte:head>

<main data-testid="v86-route" class="min-h-screen bg-neutral-950 px-3 py-3 text-gray-100 sm:px-5 sm:py-5">
	<section class="mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[100rem] flex-col overflow-hidden rounded-md border border-neutral-800 bg-black sm:min-h-[calc(100vh-2.5rem)]">
		<header class="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-3">
			<div>
				<h1 class="text-base font-semibold">Iris WebVM</h1>
				<div data-testid="v86-status" class="mt-1 text-xs text-gray-400">{vmSummary}</div>
			</div>
			<div class="text-right text-xs">
				<div data-testid="v86-fips-state" class:text-emerald-300={fipsStatus.state === 'ready'} class:text-red-300={fipsStatus.state === 'failed' || fipsStatus.state === 'error'}>
					{fipsStatus.state === 'ready' ? 'FIPS connected' : `FIPS ${fipsStatus.state}`}
				</div>
				{#if fipsStatus.ethernetPeers || fipsStatus.webrtcPeers}
					<div class="mt-1 text-gray-500">Ethernet {fipsStatus.ethernetPeers} · WebRTC {fipsStatus.webrtcPeers}</div>
				{/if}
			</div>
		</header>

		{#if vmError || fipsStatus.error}
			<div data-testid="v86-error" class="border-b border-red-950 bg-red-950/40 px-4 py-2 text-xs text-red-200">
				{vmError || fipsStatus.error}
			</div>
		{/if}

		<div bind:this={screenContainer} data-testid="v86-screen" class="v86-screen min-h-[32rem] flex-1 bg-black"></div>

		<div
			bind:this={serialConsole}
			data-testid="v86-serial"
			class="h-48 w-full border-t border-neutral-800 bg-neutral-950 p-2"
			role="application"
			aria-label="WebVM serial console"
		></div>
	</section>
</main>

<style>
	.v86-screen :global(canvas) {
		display: block;
		max-width: 100%;
	}

	.v86-screen :global(div) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
		white-space: pre;
	}
</style>
