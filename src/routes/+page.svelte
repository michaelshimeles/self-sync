<script lang="ts">
	import {
		AlertCircle,
		CheckCircle2,
		Cloud,
		Database,
		HardDrive,
		Plus,
		RefreshCw,
		Server,
		Trash2,
		Wifi,
		WifiOff
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import {
		addLocalItem,
		deleteLocalItem,
		localItems,
		localSummary,
		outboxItems,
		realtimeActivity,
		updateLocalItem
	} from '$lib/client/local-store';
	import { startSyncLoop, syncNow } from '$lib/client/sync-engine';
	import type { LocalItem } from '$lib/shared/types';
	import { cn } from '$lib/utils/cn';

	let name = $state('');
	let note = $state('');
	let formError = $state('');
	let pendingDelete = $state<LocalItem | null>(null);
	let confirmDialog = $state<HTMLDialogElement | null>(null);
	let cleanup = $state<() => void>(() => {});

	onMount(() => {
		cleanup = startSyncLoop();
		return () => cleanup();
	});

	$effect(() => {
		if (!confirmDialog) return;

		if (pendingDelete && !confirmDialog.open) {
			confirmDialog.showModal();
		}

		if (!pendingDelete && confirmDialog.open) {
			confirmDialog.close();
		}
	});

	async function handleAdd(event: SubmitEvent) {
		event.preventDefault();
		formError = '';

		if (!name.trim()) {
			formError = 'Name is required.';
			return;
		}

		await addLocalItem({ name, note });
		name = '';
		note = '';
	}

	async function handleDeleteConfirmed() {
		if (!pendingDelete) return;

		await deleteLocalItem(pendingDelete.id);
		pendingDelete = null;
		void syncNow('manual');
	}

	function formatTime(value: number | null) {
		if (!value) return 'Never';
		return new Intl.DateTimeFormat(undefined, {
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit'
		}).format(value);
	}

	function statusLabel(item: LocalItem) {
		if (item.syncStatus === 'synced') return 'Synced';
		if (item.syncStatus === 'error') return 'Retrying';
		return 'Queued';
	}
</script>

<div class="min-h-dvh bg-zinc-50">
	<header class="border-b border-zinc-200 bg-white">
		<div class="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
			<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div>
					<p class="text-sm font-medium text-emerald-700">SvelteKit + Effect + Local-first</p>
					<h1 class="text-balance text-2xl font-semibold text-zinc-950 sm:text-3xl">
						Self Sync
					</h1>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<span
						class={cn(
							'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium',
							$localSummary.online
								? 'border-emerald-200 bg-emerald-50 text-emerald-800'
								: 'border-amber-200 bg-amber-50 text-amber-800'
						)}
					>
						{#if $localSummary.online}
							<Wifi class="size-4" />
							Online
						{:else}
							<WifiOff class="size-4" />
							Offline
						{/if}
					</span>

					<button
						type="button"
						class="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-950"
						onclick={() => syncNow('manual')}
					>
						<RefreshCw class="size-4" />
						Sync
					</button>
				</div>
			</div>

			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium text-zinc-600">Local records</p>
						<HardDrive class="size-4 text-zinc-500" />
					</div>
					<p class="mt-2 text-2xl font-semibold tabular-nums">{$localSummary.total}</p>
				</div>

				<div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium text-zinc-600">Queued writes</p>
						<Database class="size-4 text-zinc-500" />
					</div>
					<p class="mt-2 text-2xl font-semibold tabular-nums">{$localSummary.queued}</p>
				</div>

				<div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium text-zinc-600">Server mode</p>
						<Server class="size-4 text-zinc-500" />
					</div>
					<p class="mt-2 truncate text-2xl font-semibold">{$localSummary.activity.databaseMode}</p>
				</div>

				<div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium text-zinc-600">Last sync</p>
						<Cloud class="size-4 text-zinc-500" />
					</div>
					<p class="mt-2 text-2xl font-semibold tabular-nums">
						{formatTime($localSummary.activity.lastSyncedAt)}
					</p>
				</div>
			</div>
		</div>
	</header>

	<main class="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8">
		<section class="space-y-4">
			<form class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm" onsubmit={handleAdd}>
				<div class="grid gap-3 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto]">
					<label class="grid gap-1">
						<span class="text-sm font-medium text-zinc-700">Name</span>
						<input
							bind:value={name}
							class="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-zinc-950 focus:ring-2 focus:ring-zinc-200"
							placeholder="Item name"
							type="text"
						/>
					</label>

					<label class="grid gap-1">
						<span class="text-sm font-medium text-zinc-700">Note</span>
						<input
							bind:value={note}
							class="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-zinc-950 focus:ring-2 focus:ring-zinc-200"
							placeholder="Optional note"
							type="text"
						/>
					</label>

					<button
						type="submit"
						class="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 md:mt-auto"
					>
						<Plus class="size-4" />
						Add
					</button>
				</div>

				{#if formError}
					<p class="mt-2 text-sm text-red-700">{formError}</p>
				{/if}
			</form>

			<div class="space-y-3">
				{#if $localItems.length === 0}
					<div class="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center shadow-sm">
						<p class="text-base font-medium text-zinc-900">No local records</p>
						<p class="mt-1 text-pretty text-sm text-zinc-600">Create one and it will appear immediately.</p>
					</div>
				{:else}
					{#each $localItems as item (item.id)}
						<article class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
							<div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
								<div class="grid gap-3">
									<input
										class="min-w-0 rounded-md border border-transparent bg-zinc-50 px-3 py-2 text-base font-medium outline-none focus:border-zinc-300 focus:bg-white focus:ring-2 focus:ring-zinc-200"
										value={item.name}
										oninput={(event) =>
											updateLocalItem(item.id, {
												name: event.currentTarget.value
											})}
									/>
									<textarea
										class="min-h-20 resize-y rounded-md border border-transparent bg-zinc-50 px-3 py-2 text-sm leading-6 text-zinc-700 outline-none focus:border-zinc-300 focus:bg-white focus:ring-2 focus:ring-zinc-200"
										value={item.note}
										oninput={(event) =>
											updateLocalItem(item.id, {
												note: event.currentTarget.value
											})}
									></textarea>
								</div>

								<div class="flex items-start justify-between gap-3 md:flex-col md:items-end">
									<span
										class={cn(
											'inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium',
											item.syncStatus === 'synced' &&
												'border-emerald-200 bg-emerald-50 text-emerald-800',
											item.syncStatus === 'pending' &&
												'border-amber-200 bg-amber-50 text-amber-800',
											item.syncStatus === 'error' && 'border-red-200 bg-red-50 text-red-800'
										)}
									>
										{#if item.syncStatus === 'synced'}
											<CheckCircle2 class="size-3.5" />
										{:else}
											<AlertCircle class="size-3.5" />
										{/if}
										{statusLabel(item)}
									</span>

									<button
										type="button"
										class="inline-flex size-9 items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-950"
										aria-label={`Delete ${item.name}`}
										title="Delete"
										onclick={() => (pendingDelete = item)}
									>
										<Trash2 class="size-4" />
									</button>
								</div>
							</div>

							{#if item.lastError}
								<p class="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
									{item.lastError}
								</p>
							{/if}
						</article>
					{/each}
				{/if}
			</div>
		</section>

		<aside class="space-y-4">
			<section class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
				<div class="flex items-center justify-between gap-3">
					<h2 class="text-base font-semibold text-zinc-950">Sync status</h2>
					<span
						class={cn(
							'rounded-md px-2 py-1 text-xs font-medium capitalize',
							$localSummary.activity.status === 'synced' && 'bg-emerald-50 text-emerald-800',
							$localSummary.activity.status === 'syncing' && 'bg-sky-50 text-sky-800',
							$localSummary.activity.status === 'offline' && 'bg-amber-50 text-amber-800',
							$localSummary.activity.status === 'error' && 'bg-red-50 text-red-800',
							$localSummary.activity.status === 'idle' && 'bg-zinc-100 text-zinc-700'
						)}
					>
						{$localSummary.activity.status}
					</span>
				</div>
				<p class="mt-3 text-pretty text-sm text-zinc-600">{$localSummary.activity.lastMessage}</p>
				{#if $localSummary.activity.error}
					<p class="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
						{$localSummary.activity.error}
					</p>
				{/if}
				<div class="mt-3 rounded-md bg-zinc-50 px-3 py-2">
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium text-zinc-700">Realtime</p>
						<span
							class={cn(
								'rounded-md px-2 py-1 text-xs font-medium capitalize',
								$realtimeActivity.status === 'connected' && 'bg-emerald-50 text-emerald-800',
								$realtimeActivity.status === 'connecting' && 'bg-sky-50 text-sky-800',
								$realtimeActivity.status === 'disconnected' && 'bg-amber-50 text-amber-800',
								$realtimeActivity.status === 'error' && 'bg-red-50 text-red-800'
							)}
						>
							{$realtimeActivity.status}
						</span>
					</div>
					<p class="mt-1 text-pretty text-xs text-zinc-600">{$realtimeActivity.message}</p>
				</div>
			</section>

			<section class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
				<h2 class="text-base font-semibold text-zinc-950">Outbox</h2>
				<div class="mt-3 space-y-2">
					{#if $outboxItems.length === 0}
						<p class="rounded-md bg-zinc-50 px-3 py-3 text-sm text-zinc-600">No queued writes.</p>
					{:else}
						{#each $outboxItems as mutation (mutation.id)}
							<div class="rounded-md border border-zinc-200 px-3 py-2">
								<div class="flex items-center justify-between gap-3">
									<p class="truncate text-sm font-medium text-zinc-900">{mutation.item.name}</p>
									<span class="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">
										{mutation.op}
									</span>
								</div>
								<p class="mt-1 text-xs text-zinc-500 tabular-nums">
									Attempts: {mutation.attempts}
								</p>
							</div>
						{/each}
					{/if}
				</div>
			</section>
		</aside>
	</main>
</div>

<dialog
	bind:this={confirmDialog}
	class="w-[min(92vw,420px)] rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-950/30"
	aria-labelledby="delete-title"
	aria-describedby="delete-description"
	onclose={() => (pendingDelete = null)}
>
	<div class="p-5">
		<h2 id="delete-title" class="text-lg font-semibold text-zinc-950">Delete record</h2>
		<p id="delete-description" class="mt-2 text-pretty text-sm text-zinc-600">
			This queues a delete mutation for {pendingDelete?.name ?? 'this record'}.
		</p>
		<div class="mt-5 flex justify-end gap-2">
			<button
				type="button"
				class="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-950"
				onclick={() => (pendingDelete = null)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
				onclick={handleDeleteConfirmed}
			>
				Delete
			</button>
		</div>
	</div>
</dialog>
