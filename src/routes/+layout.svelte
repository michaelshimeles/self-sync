<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta
		name="description"
		content="A SvelteKit, Effect, and SQL-backed local-first sync engine."
	/>
</svelte:head>
{@render children()}
