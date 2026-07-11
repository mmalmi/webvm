<script>
	export let diskStatus;
	export let diskUsageBytes;
	export let resetting;
	export let onReset;

	function formatBytes(bytes) {
		if (!Number.isFinite(bytes)) return '';
		const units = ['B', 'KB', 'MB', 'GB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1_000 && unit < units.length - 1) {
			value /= 1_000;
			unit += 1;
		}
		return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
	}

	$: diskSize = formatBytes(diskUsageBytes);
</script>

<div class="vm-toolbar" aria-label="WebVM controls">
	<span>
		{diskStatus === 'ready' ? 'Local disk' : `Disk ${diskStatus}`}{diskSize ? ` · ${diskSize}` : ''}
	</span>
	<button data-testid="v86-reset" type="button" on:click={onReset} disabled={resetting}>
		Reset VM
	</button>
</div>

<style>
	.vm-toolbar {
		position: fixed;
		right: 0.75rem;
		bottom: 0.75rem;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.35rem 0.5rem;
		border: 1px solid #303030;
		border-radius: 0.35rem;
		background: rgb(0 0 0 / 82%);
		color: #a1a1aa;
		font: 12px/1.2 monospace;
	}

	button {
		color: #e4e4e7;
	}

	button:hover:not(:disabled) {
		color: white;
		text-decoration: underline;
	}
</style>
