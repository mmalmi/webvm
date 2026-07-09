<script>
	import QRCode from 'qrcode';
	import { onMount } from 'svelte';
	import {
		copyJoinRequestLink,
		createJoinRequestLink,
		markJoinRequestOpened,
		nostrVpnAction,
		nostrVpnIdentity,
		resetNostrVpnIdentity,
		startNostrVpnReceiptListener,
		updateNostrVpnNodeName,
	} from '$lib/nostrVpn.js';
	import { getNostrVpnTransportStatus } from '$lib/nostrVpnTransport.js';

	let nodeName = '';
	let qrCodeDataUrl = '';
	let qrRenderId = 0;
	let mounted = false;
	const transportStatus = getNostrVpnTransportStatus();

	$: nodeName = $nostrVpnIdentity.nodeName;
	$: joinRequestLink = createJoinRequestLink($nostrVpnIdentity);
	$: paired = Boolean($nostrVpnIdentity.paired);
	$: if (mounted && $nostrVpnIdentity.requestPubkeyHex) {
		startNostrVpnReceiptListener();
	}
	$: statusText = paired
		? 'Paired'
		: {
				idle: 'Ready',
				opened: 'Opened native app',
				copied: 'Copied',
				'copy-unavailable': 'Copy unavailable',
				'pairing-mismatch': 'Secret mismatch',
				reset: 'New request',
				saved: 'Name saved',
			}[$nostrVpnAction] || 'Ready';
	$: renderQrCode(joinRequestLink);

	async function renderQrCode(value) {
		const renderId = ++qrRenderId;
		const dataUrl = await QRCode.toDataURL(value, {
			errorCorrectionLevel: 'M',
			margin: 1,
			width: 224,
			color: {
				dark: '#111827',
				light: '#ffffff',
			},
		});
		if (renderId === qrRenderId) {
			qrCodeDataUrl = dataUrl;
		}
	}

	function saveNodeName() {
		updateNostrVpnNodeName(nodeName);
	}

	function handleNameKeydown(event) {
		if (event.key === 'Enter') {
			event.currentTarget.blur();
		}
	}

	onMount(() => {
		mounted = true;
		startNostrVpnReceiptListener();
	});
</script>

<h1 class="text-lg font-bold">Nostr VPN</h1>

<div class="space-y-3 text-sm">
	<div class="rounded-md bg-neutral-700 p-3 shadow-md shadow-neutral-900">
		<div class="mb-3 flex items-center justify-between gap-3">
			<span class="font-semibold">Pairing</span>
			<span
				data-testid="nostr-vpn-pairing-status"
				class:status-paired={paired}
				class="rounded bg-neutral-800 px-2 py-1 text-xs text-emerald-300"
			>
				{statusText}
			</span>
		</div>

		{#if qrCodeDataUrl}
			<div class="flex justify-center">
				<img
					data-testid="nostr-vpn-qr"
					class="h-56 w-56 rounded bg-white p-2"
					src={qrCodeDataUrl}
					alt="Nostr VPN join request QR"
				/>
			</div>
		{/if}

		<div class="mt-3 flex gap-2">
			<a
				data-testid="nostr-vpn-open"
				class="flex-1 rounded bg-emerald-700 px-3 py-2 text-center text-sm text-white hover:bg-emerald-600"
				href={joinRequestLink}
				target="_blank"
				on:click={markJoinRequestOpened}
			>
				Open
			</a>
			<button
				data-testid="nostr-vpn-copy"
				class="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-500"
				type="button"
				on:click={copyJoinRequestLink}
			>
				Copy
			</button>
			<button
				data-testid="nostr-vpn-reset"
				class="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-500"
				type="button"
				on:click={resetNostrVpnIdentity}
			>
				Reset
			</button>
		</div>
	</div>

	<label class="block">
		<span class="mb-1 block text-gray-300">Name</span>
		<input
			data-testid="nostr-vpn-node-name"
			class="w-full rounded bg-neutral-800 px-2 py-2 text-gray-100 outline-none ring-1 ring-neutral-500 focus:ring-emerald-400"
			bind:value={nodeName}
			on:blur={saveNodeName}
			on:keydown={handleNameKeydown}
			maxlength="80"
		/>
	</label>

	<div class="rounded-md bg-neutral-700 p-3 shadow-md shadow-neutral-900">
		<div class="mb-2 font-semibold">Request</div>
		<div
			data-testid="nostr-vpn-join-request"
			class="max-h-28 overflow-auto break-all rounded bg-neutral-900 p-2 font-mono text-xs text-gray-200"
		>
			{joinRequestLink}
		</div>
	</div>

	{#if paired}
		<div class="rounded-md bg-emerald-900/60 p-3 text-emerald-100 shadow-md shadow-neutral-900">
			<div class="font-semibold">Native app accepted</div>
			{#if $nostrVpnIdentity.paired.networkName}
				<div class="mt-1 text-xs text-emerald-200">{$nostrVpnIdentity.paired.networkName}</div>
			{/if}
		</div>
		<div
			data-testid="nostr-vpn-transport-status"
			class="rounded-md bg-neutral-700 p-3 text-gray-100 shadow-md shadow-neutral-900"
		>
			<div class="font-semibold">VM network</div>
			<div class="mt-1 text-xs text-amber-200">{transportStatus.summary}</div>
		</div>
	{:else}
		<p class="text-gray-300">Scan this request with a Nostr VPN admin device.</p>
	{/if}
</div>

<style>
	.status-paired {
		color: rgb(167 243 208);
	}
</style>
