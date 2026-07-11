<script>
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import VmToolbar from '$lib/VmToolbar.svelte';
	import { createWebvmFipsHost } from '$lib/webvmFipsHost.js';
	import { attachWebvmDisk } from '$lib/webvmDisk.js';
	import '$lib/global.css';
	import '@xterm/xterm/css/xterm.css';

	const BIOS_URL = '/v86/seabios.bin';
	const VGA_BIOS_URL = '/v86/vgabios.bin';
	const V86_WASM_URL = '/v86/v86.wasm';
	const GUEST_FS_URL = '/v86/guest/fs.json';
	const GUEST_ROOTFS_URL = '/v86/guest/rootfs/';
	const GUEST_MANIFEST_URL = '/v86/guest/manifest.json';
	const GUEST_STATE_MANIFEST_URL = '/v86/guest/state/manifest.json';
	const SERIAL_BUFFER_LIMIT = 128 * 1024;
	const WELCOME_BORDER = '+----------------------------------------------------------------------------+';
	const RESUME_READY_MARKER = '__IRIS_WEBVM_RESUMED__';
	const STARTUP_STATUS_TEXT = 'Starting Linux...\r\n';
	const INTRO_TEXT = `${WELCOME_BORDER}
| Iris WebVM                                                                |
|                                                                            |
| A private Linux workspace running entirely in your browser.                |
| FIPS networking and Hashtree work immediately, without a VPN login.        |
| Download Nostr VPN (nostrvpn.org) to approve this device and add an exit.  |
${WELCOME_BORDER}

  Nostr VPN join request:  nvpn join-request
  FIPS and peer status:    nvpn status
  Hashtree:                htree add <path>  |  htree cat <nhash>
  Git over htree:          git clone htree://<npub>/<repo>

  Private names:   <npub>.fips
  Hashtree sites:  <nhash>.iris.localhost
                   <site>.<npub>.iris.localhost

`;

	let destroyed = false;
	let screenContainer;
	let serialConsole;
	let serialTerminal = null;
	let serialFitAddon = null;
	let serialInputDisposable = null;
	let serialResizeObserver = null;
	let emulator = null;
	let diskController = null;
	let diskStatus = 'loading';
	let resettingVm = false;
	let fipsHost = null;
	let terminalReady = false;
	let startupOutput = '';
	let resumeRequested = false;
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
				if (terminalReady) {
					serialTerminal?.write(text);
					return;
				}

				startupOutput += text;
				if (startupOutput.length > SERIAL_BUFFER_LIMIT) {
					startupOutput = startupOutput.slice(-SERIAL_BUFFER_LIMIT);
				}
				const markerIndex = startupOutput.indexOf(RESUME_READY_MARKER);
				if (markerIndex < 0) {
					if (
						!resumeRequested &&
						startupOutput.includes(WELCOME_BORDER) &&
						/[\w()-]+:~[#$]\s/.test(startupOutput)
					) {
						requestGuestResume(instance);
					}
					return;
				}

				const resumedOutput = startupOutput
					.slice(markerIndex + RESUME_READY_MARKER.length)
					.replace(/^\r?\n/, '');
				if (!resumedOutput.includes('root@webvm:~# ')) return;
				serialTerminal?.reset();
				serialTerminal?.write(INTRO_TEXT);
				serialTerminal?.write(resumedOutput);
				startupOutput = '';
				terminalReady = true;
				if (serialTerminal) serialTerminal.options = { disableStdin: false };
				serialTerminal?.focus();
				publishDebugState();
			}),
		];
	}

	async function initializeSerialTerminal() {
		const { Terminal } = await import('@xterm/xterm');
		const { FitAddon } = await import('@xterm/addon-fit');
		if (destroyed) return;
		serialTerminal = new Terminal({
			convertEol: true,
			cursorBlink: true,
			disableStdin: true,
			fontFamily: 'monospace',
			fontSize: 16,
			letterSpacing: 0,
			scrollback: 5_000,
			theme: {
				background: '#000000',
				foreground: '#f4f4f5',
			},
		});
		serialFitAddon = new FitAddon();
		serialTerminal.loadAddon(serialFitAddon);
		serialTerminal.open(serialConsole);
		serialFitAddon.fit();
		serialTerminal.write(`${INTRO_TEXT}${STARTUP_STATUS_TEXT}`);
		serialInputDisposable = serialTerminal.onData((data) => {
			if (terminalReady) emulator?.serial0_send?.(data);
		});
		serialTerminal.focus();
		serialResizeObserver = new ResizeObserver(() => {
			if (serialConsole?.dataset.e2eStyle !== undefined) return;
			serialFitAddon?.fit();
		});
		serialResizeObserver.observe(serialConsole);
		publishDebugState();
	}

	function requestGuestResume(instance) {
		if (resumeRequested) return;
		resumeRequested = true;
		const snapshotBuild = new URLSearchParams(globalThis.location.search).has('snapshot-build');
		const entropy = crypto.getRandomValues(new Uint8Array(64));
		const entropyHex = [...entropy]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		setTimeout(() => {
			instance.serial0_send?.(
				`stty echo; printf '%s' '${entropyHex}' | xxd -r -p > /dev/urandom; ` +
				`hostname webvm; export PS1='root@webvm:\\w# '; ` +
				(snapshotBuild ? '' :
					`sh -c '(rc-service webvm-nvpn start) >/dev/null 2>&1 &'; ` +
					`for attempt in $(seq 1 150); do ` +
					`grep -q "^# Managed by nvpn WebVM FIPS$" /etc/resolv.conf && break; ` +
					`sleep 0.1; done; ` +
					`sh -c '(rc-service webvm-hashtree start) >/dev/null 2>&1 &'; `) +
				`exec /bin/ash -c "printf '\\n__IRIS_WEBVM_%s__\\n' RESUMED; exec /bin/ash"\n`,
			);
		}, 50);
	}

	async function sha256Hex(bytes) {
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		return [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
	}

	async function loadPreinitializedState() {
		if (new URLSearchParams(globalThis.location.search).has('cold-boot')) return null;
		const manifestResponse = await fetch(GUEST_STATE_MANIFEST_URL);
		if (manifestResponse.status === 404) return null;
		if (!manifestResponse.ok) {
			throw new Error(`Failed to load WebVM state manifest (${manifestResponse.status})`);
		}
		const manifest = await manifestResponse.json();
		if (manifest.schema !== 1 || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
			throw new Error('Invalid WebVM state manifest');
		}
		const chunks = await Promise.all(manifest.chunks.map(async (chunk) => {
			const response = await fetch(new URL(chunk.file, manifestResponse.url));
			if (!response.ok) throw new Error(`Failed to load WebVM state chunk ${chunk.file}`);
			const bytes = await response.arrayBuffer();
			if (bytes.byteLength !== chunk.bytes || await sha256Hex(bytes) !== chunk.sha256) {
				throw new Error(`WebVM state chunk ${chunk.file} failed integrity verification`);
			}
			return new Uint8Array(bytes);
		}));
		const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
		if (totalBytes !== manifest.bytes) throw new Error('WebVM state size does not match its manifest');
		const state = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			state.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return state.buffer;
	}

	async function diskCompatibilityId() {
		const response = await fetch(GUEST_MANIFEST_URL);
		if (!response.ok) throw new Error(`Failed to load WebVM guest manifest (${response.status})`);
		const manifest = await response.json();
		const rootfsHash = manifest.artifacts?.rootfs?.sha256;
		if (!rootfsHash) throw new Error('WebVM guest manifest has no root filesystem identity');
		return `${manifest.schema}:${rootfsHash}`;
	}

	async function attachPersistentDisk(instance) {
		try {
			diskController = await attachWebvmDisk({
				compatibilityId: await diskCompatibilityId(),
				filesystem: instance.fs9p,
				onStatus(status) {
					diskStatus = status;
				},
			});
		} catch (error) {
			console.error('Failed to initialize the WebVM local disk', error);
			diskStatus = 'unavailable';
		}
	}

	async function resetVm() {
		if (resettingVm || !confirm('Delete this browser\'s saved WebVM disk and start clean?')) return;
		resettingVm = true;
		diskStatus = 'resetting';
		await diskController?.reset();
		globalThis.location.reload();
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
			logger: localDiagnosticsEnabled() ? console : undefined,
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
		const statePromise = loadPreinitializedState().catch((error) => {
			console.error('Preinitialized WebVM state is unavailable; using a cold boot', error);
			return null;
		});
		const options = {
			wasm_path: V86_WASM_URL,
			memory_size: 96 * 1024 * 1024,
			vga_memory_size: 8 * 1024 * 1024,
			autostart: false,
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
			const emulatorReady = new Promise((resolve) => {
				instance.add_listener?.('emulator-ready', resolve);
			});
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

			const state = await statePromise;
			await emulatorReady;
			if (destroyed) return;
			if (state && instance.restore_state) {
				await instance.restore_state(state);
			}
			await attachPersistentDisk(instance);
			instance.run?.();
			if (state) requestGuestResume(instance);
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
			flushDisk: () => diskController?.flush(),
			serialTerminal,
			state: () => ({
				vmState,
				vmSummary,
				vmError,
				fipsStatus,
				terminalReady,
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
		serialResizeObserver?.disconnect?.();
		serialResizeObserver = null;
		serialFitAddon = null;
		serialTerminal?.dispose?.();
		serialTerminal = null;
		diskController?.dispose();
		diskController = null;
		void fipsHost?.stop?.();
		void emulator?.destroy?.();
		if (localDiagnosticsEnabled()) delete globalThis.irisWebvmV86;
	});
</script>

<svelte:head>
	<title>Iris WebVM</title>
</svelte:head>

<main data-testid="v86-route" class="relative h-screen w-screen overflow-hidden bg-black text-gray-100">
	<header class="hidden">
		<h1>Iris WebVM</h1>
		<div data-testid="v86-status">{vmSummary}</div>
		<div data-testid="v86-fips-state">
			{fipsStatus.state === 'ready' ? 'FIPS connected' : `FIPS ${fipsStatus.state}`}
		</div>
		<div>Ethernet {fipsStatus.ethernetPeers} · WebRTC {fipsStatus.webrtcPeers}</div>
	</header>

	{#if vmError || fipsStatus.error}
		<div data-testid="v86-error" class="sr-only">{vmError || fipsStatus.error}</div>
	{/if}

	<div bind:this={screenContainer} data-testid="v86-screen" class="v86-screen" aria-hidden="true"></div>
	<div
		bind:this={serialConsole}
		data-testid="v86-serial"
		class="absolute inset-0 bg-black p-1"
		role="application"
		aria-label="Iris WebVM terminal"
	></div>
	<VmToolbar {diskStatus} resetting={resettingVm} onReset={resetVm} />
</main>

<style>
	:global(.xterm) {
		height: 100%;
	}

	.v86-screen :global(canvas) {
		display: block;
	}

	.v86-screen {
		position: fixed;
		top: 0;
		left: -10000px;
		width: 640px;
		height: 480px;
		overflow: hidden;
		pointer-events: none;
	}

</style>
