<script>
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import NostrVpnTab from '$lib/NostrVpnTab.svelte';
	import {
		nostrVpnIdentity,
		nostrVpnTransportStatus,
		startNostrVpnFipsTransport,
		stopNostrVpnFipsTransport,
	} from '$lib/nostrVpn.js';
	import { createNostrVpnV86PacketBackend } from '$lib/v86PacketBackend.js';
	import '$lib/global.css';

	const BIOS_URL = '/v86/seabios.bin';
	const VGA_BIOS_URL = '/v86/vgabios.bin';
	const V86_WASM_URL = '/v86/v86.wasm';
	const BUILDROOT_KERNEL_URL = 'https://i.copy.sh/buildroot-bzimage68.bin';

	let mounted = false;
	let destroyed = false;
	let screenContainer;
	let serialConsole;
	let emulator = null;
	let packetBackend = null;
	let startedWithPacketBackend = false;
	let attachInFlight = false;
	let lastAttachKey = '';
	let vmState = 'loading';
	let vmSummary = 'Loading v86';
	let vmError = '';
	let bridgeState = 'waiting-pairing';
	let bridgeSummary = 'Pair with Nostr VPN';
	let bridgeError = '';
	let backendStatus = null;
	let lastTransportStatus = null;

	$: paired = Boolean($nostrVpnIdentity.paired);
	$: networkId = meshNetworkId($nostrVpnIdentity);
	$: pairedContextKey = JSON.stringify($nostrVpnIdentity.paired || {});
	$: currentAttachKey = paired && emulator
		? `${$nostrVpnIdentity.appPubkeyHex}:${networkId}:${pairedContextKey}`
		: '';
	$: if (mounted && currentAttachKey && currentAttachKey !== lastAttachKey && !attachInFlight) {
		void attachNostrVpnPacketBackend(currentAttachKey);
	}
	$: if (mounted && !paired && bridgeState !== 'waiting-pairing') {
		resetBridgeState();
	}

	function meshNetworkId(identity) {
		const pairedDetail = identity?.paired || {};
		return [
			pairedDetail.meshNetworkId,
			pairedDetail.mesh_network_id,
			pairedDetail.networkId,
			pairedDetail.network_id,
		]
			.map((value) => String(value || '').trim())
			.find(Boolean) || '';
	}

	function messageFromError(error) {
		return error instanceof Error ? error.message : String(error || 'Unknown error');
	}

	function isMissingNativeMeshContext(error) {
		return /exit peer|mesh context|native mesh|compressed.*pubkey|packet bridge requires/i
			.test(messageFromError(error));
	}

	function resetBridgeState() {
		packetBackend = null;
		startedWithPacketBackend = false;
		lastAttachKey = '';
		backendStatus = null;
		lastTransportStatus = null;
		bridgeError = '';
		bridgeState = paired ? 'waiting-vm' : 'waiting-pairing';
		bridgeSummary = paired ? 'Waiting for v86' : 'Pair with Nostr VPN';
		publishDebugState();
	}

	function addEmulatorListener(instance, event, handler) {
		instance?.add_listener?.(event, handler);
		return () => instance?.remove_listener?.(event, handler);
	}

	let removeEmulatorListeners = [];

	function installEmulatorListeners(instance) {
		removeEmulatorListeners = [
			addEmulatorListener(instance, 'emulator-loaded', () => {
				vmState = 'loaded';
				vmSummary = 'v86 loaded';
				publishDebugState();
			}),
			addEmulatorListener(instance, 'emulator-ready', () => {
				vmState = 'ready';
				vmSummary = 'v86 ready';
				publishDebugState();
			}),
			addEmulatorListener(instance, 'emulator-started', () => {
				vmState = 'running';
				vmSummary = 'v86 running';
				publishDebugState();
			}),
			addEmulatorListener(instance, 'download-error', (event) => {
				vmState = 'load-failed';
				vmError = `Failed to load ${event?.file_name || 'v86 asset'}`;
				vmSummary = vmError;
				publishDebugState();
			}),
		];
	}

	function getTestHooks() {
		return browser ? globalThis.irisWebvmV86TestHooks || null : null;
	}

	async function createV86Instance(options) {
		const hook = getTestHooks()?.createV86;
		if (hook) {
			return hook(options);
		}
		const { V86 } = await import('v86');
		return new V86(options);
	}

	async function startFipsTransportWithPacketBackend(options) {
		const hook = getTestHooks()?.startFipsTransport;
		if (hook) {
			return hook(options);
		}
		return startNostrVpnFipsTransport(options);
	}

	async function bootV86() {
		vmState = 'loading';
		vmSummary = 'Loading v86';
		vmError = '';
		const options = {
			wasm_path: V86_WASM_URL,
			memory_size: 128 * 1024 * 1024,
			vga_memory_size: 8 * 1024 * 1024,
			autostart: true,
			fastboot: true,
			disable_speaker: true,
			bios: { url: BIOS_URL },
			vga_bios: { url: VGA_BIOS_URL },
			bzimage: { url: BUILDROOT_KERNEL_URL },
			cmdline: 'console=ttyS0 console=tty0 ip=dhcp loglevel=3',
			screen: {
				container: screenContainer,
				use_graphical_text: true,
			},
			serial_container: serialConsole,
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
			vmSummary = 'v86 initialized';
			if (paired) {
				bridgeState = 'waiting-backend';
				bridgeSummary = 'Preparing VM packet backend';
			}
			publishDebugState();
		} catch (error) {
			vmState = 'load-failed';
			vmError = messageFromError(error);
			vmSummary = vmError || 'v86 failed to load';
			publishDebugState();
		}
	}

	async function attachNostrVpnPacketBackend(nextAttachKey) {
		lastAttachKey = nextAttachKey;
		attachInFlight = true;
		bridgeError = '';
		const identity = get(nostrVpnIdentity);
		const currentNetworkId = meshNetworkId(identity);

		try {
			if (!emulator) {
				bridgeState = 'waiting-vm';
				bridgeSummary = 'Waiting for v86';
				return;
			}
			if (!currentNetworkId) {
				bridgeState = 'waiting-native-mesh-context';
				bridgeSummary = 'Waiting for native mesh context';
				return;
			}

			bridgeState = 'backend-attaching';
			bridgeSummary = 'Preparing VM packet backend';
			packetBackend = await createNostrVpnV86PacketBackend(emulator, {
				networkId: currentNetworkId,
				appPubkeyHex: identity.appPubkeyHex,
			});
			backendStatus = packetBackend.status?.() || null;
			bridgeState = 'fips-starting';
			bridgeSummary = 'Starting Nostr VPN packet bridge';
			publishDebugState();

			const transportStatus = await startFipsTransportWithPacketBackend({ packetBackend });
			lastTransportStatus = transportStatus;
			startedWithPacketBackend = Boolean(transportStatus?.packetBridgeAttached);
			bridgeState = transportStatus?.packetBridgeAttached
				? 'packet-bridge-ready'
				: 'waiting-native-mesh-context';
			bridgeSummary = transportStatus?.packetBridgeAttached
				? 'Nostr VPN packet bridge ready'
				: 'Waiting for native mesh context';
		} catch (error) {
			if (isMissingNativeMeshContext(error)) {
				bridgeState = 'waiting-native-mesh-context';
				bridgeSummary = 'Waiting for native mesh context';
			} else {
				bridgeState = 'fips-start-failed';
				bridgeSummary = 'Nostr VPN packet bridge failed';
			}
			bridgeError = messageFromError(error);
		} finally {
			attachInFlight = false;
			publishDebugState();
		}
	}

	function publishDebugState() {
		if (!browser) {
			return;
		}
		globalThis.irisWebvmV86 = {
			emulator,
			packetBackend,
			state: () => ({
				vmState,
				vmSummary,
				vmError,
				bridgeState,
				bridgeSummary,
				bridgeError,
				backendStatus,
				lastTransportStatus,
			}),
			attachPacketBackend: () => attachNostrVpnPacketBackend(currentAttachKey),
		};
	}

	onMount(() => {
		mounted = true;
		resetBridgeState();
		void bootV86();
	});

	onDestroy(() => {
		destroyed = true;
		for (const removeListener of removeEmulatorListeners) {
			removeListener?.();
		}
		removeEmulatorListeners = [];
		if (startedWithPacketBackend) {
			void stopNostrVpnFipsTransport().catch(() => {});
		}
		void emulator?.destroy?.();
		if (browser) {
			delete globalThis.irisWebvmV86;
		}
	});
</script>

<svelte:head>
	<title>v86 Nostr VPN WebVM</title>
</svelte:head>

<main data-testid="v86-route" class="min-h-screen bg-neutral-950 text-gray-100">
	<div class="mx-auto grid min-h-screen max-w-7xl grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
		<section class="flex min-h-[70vh] flex-col overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
			<div class="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
				<div>
					<h1 class="text-base font-semibold">v86 WebVM</h1>
					<div data-testid="v86-status" class="mt-1 text-xs text-gray-300">{vmSummary}</div>
				</div>
				<div
					data-testid="v86-nvpn-state"
					class="rounded bg-neutral-800 px-3 py-1 text-xs text-emerald-200"
					class:text-amber-200={bridgeState === 'waiting-native-mesh-context' || bridgeState === 'waiting-pairing'}
					class:text-red-200={bridgeState === 'fips-start-failed'}
				>
					{bridgeSummary}
				</div>
			</div>

			<div
				bind:this={screenContainer}
				data-testid="v86-screen"
				class="v86-screen min-h-[28rem] flex-1 bg-black"
			></div>

			<textarea
				bind:this={serialConsole}
				data-testid="v86-serial"
				class="h-28 w-full resize-none border-t border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-emerald-100 outline-none"
				readonly
				aria-label="v86 serial console"
			></textarea>
		</section>

		<aside class="space-y-4">
			<section class="rounded-md border border-neutral-800 bg-neutral-900 p-4">
				<NostrVpnTab />
			</section>

			<section class="rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm">
				<h2 class="mb-3 text-base font-semibold">Packet transport</h2>
				<div data-testid="v86-backend-status" class="space-y-2 text-xs text-gray-300">
					<div>{bridgeSummary}</div>
					{#if backendStatus}
						<div>Guest IP {backendStatus.guestIp}</div>
					{/if}
					{#if bridgeError}
						<div class="break-words text-amber-200">{bridgeError}</div>
					{/if}
					<div class="break-words text-gray-400">{$nostrVpnTransportStatus.summary}</div>
				</div>
			</section>
		</aside>
	</div>
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
