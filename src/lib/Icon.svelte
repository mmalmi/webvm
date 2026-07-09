<script>
	export let icon;
	export let info;
	export let activity;
	import { createEventDispatcher } from 'svelte';

	const dispatch = createEventDispatcher();
	function handleMouseover() {
		dispatch('mouseover', info);
	}
	function handleClick() {
		dispatch('click', { icon, info });
	}
	function handleKeydown(event) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleClick();
		}
	}
	$: testId = info ? `sidebar-${info.toLowerCase().replaceAll(' ', '-')}` : undefined;
</script>

<div 
	class="p-3 cursor-pointer text-center hover:bg-neutral-600 {$activity ? "text-amber-500 animate-pulse" : "hover:text-gray-100"}"
	style="animation-duration: 0.5s"
	role="button"
	tabindex="0"
	title={info}
	aria-label={info}
	data-testid={testId}
	on:mouseenter={handleMouseover}
	on:click={handleClick}
	on:keydown={handleKeydown}
>
	<i class='{icon} fa-xl'></i>
</div>
