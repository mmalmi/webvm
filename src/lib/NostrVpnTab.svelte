<script>
	import PanelButton from './PanelButton.svelte';
	import {
		copyJoinRequestLink,
		createJoinRequestLink,
		markJoinRequestOpened,
		nostrVpnAction,
		nostrVpnIdentity,
		resetNostrVpnIdentity,
		updateNostrVpnNodeName,
	} from '$lib/nostrVpn.js';

	let nodeName = '';
	$: nodeName = $nostrVpnIdentity.nodeName;
	$: joinRequestLink = createJoinRequestLink($nostrVpnIdentity);
	$: actionText = {
		idle: 'Ready',
		opened: 'Opened native app',
		copied: 'Join link copied',
		'copy-unavailable': 'Copy unavailable',
		reset: 'New browser identity',
		saved: 'Name saved',
	}[$nostrVpnAction] || 'Ready';

	function saveNodeName() {
		updateNostrVpnNodeName(nodeName);
	}

	function handleNameKeydown(event) {
		if (event.key === 'Enter') {
			event.currentTarget.blur();
		}
	}
</script>

<h1 class="text-lg font-bold">Nostr VPN</h1>

<PanelButton
	buttonIcon="fas fa-lock"
	clickUrl={joinRequestLink}
	clickHandler={markJoinRequestOpened}
	buttonTooltip="Open this join request in the native Nostr VPN app"
	buttonText="Open Nostr VPN"
/>

<div class="space-y-3 text-sm">
	<div class="rounded-md bg-neutral-700 p-3 shadow-md shadow-neutral-900">
		<div class="flex items-center justify-between gap-3">
			<span class="font-semibold">Pairing</span>
			<span class="rounded bg-neutral-800 px-2 py-1 text-xs text-emerald-300">{actionText}</span>
		</div>
		<div class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-gray-200">
			<span class="text-emerald-300">Ready</span>
			<span>Browser identity</span>
			<span class="text-emerald-300">Ready</span>
			<span>Native app link</span>
			<span class="text-amber-300">Next</span>
			<span>CheerpX packet backend</span>
		</div>
	</div>

	<label class="block">
		<span class="mb-1 block text-gray-300">Node name</span>
		<input
			class="w-full rounded bg-neutral-800 px-2 py-2 text-gray-100 outline-none ring-1 ring-neutral-500 focus:ring-emerald-400"
			bind:value={nodeName}
			on:blur={saveNodeName}
			on:keydown={handleNameKeydown}
			maxlength="80"
		/>
	</label>

	<div class="rounded-md bg-neutral-700 p-3 shadow-md shadow-neutral-900">
		<div class="mb-2 font-semibold">Join request</div>
		<div class="break-all rounded bg-neutral-900 p-2 font-mono text-xs text-gray-200">{joinRequestLink}</div>
		<div class="mt-3 flex gap-2">
			<button
				class="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-500"
				type="button"
				on:click={copyJoinRequestLink}
			>
				Copy
			</button>
			<button
				class="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-500"
				type="button"
				on:click={resetNostrVpnIdentity}
			>
				Reset
			</button>
		</div>
	</div>

	<p class="text-gray-300">
		Pair this WebVM with a native Nostr VPN admin app. Internet packets need the Nostr VPN WebVM backend before this replaces Tailscale.
	</p>
</div>
