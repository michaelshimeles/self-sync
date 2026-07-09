<script lang="ts">
	import {
		AlertCircle,
		ArrowLeft,
		ArrowRight,
		CheckCircle2,
		Cloud,
		Columns3,
		Database,
		GripVertical,
		HardDrive,
		MessageSquare,
		Plus,
		RefreshCw,
		Send,
		Server,
		Trash2,
		Wifi,
		WifiOff
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
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
	import type { KanbanStage, LocalItem } from '$lib/shared/types';
	import { cn } from '$lib/utils';

	const kanbanStages: ReadonlyArray<{ id: KanbanStage; label: string; description: string }> = [
		{ id: 'todo', label: 'To do', description: 'Queued ideas and new work' },
		{ id: 'doing', label: 'Doing', description: 'Active work in progress' },
		{ id: 'done', label: 'Done', description: 'Completed and synced' }
	];

	let activeTab = $state('chat');
	let name = $state('');
	let note = $state('');
	let formError = $state('');
	let chatMessage = $state('');
	let chatError = $state('');
	let pendingDelete = $state<LocalItem | null>(null);
	let deleteDialogOpen = $state(false);
	let draggedItemId = $state<string | null>(null);
	let dragOverStage = $state<KanbanStage | null>(null);
	let cleanup = $state<() => void>(() => {});

	onMount(() => {
		cleanup = startSyncLoop();
		return () => cleanup();
	});

	async function handleAdd(event: SubmitEvent) {
		event.preventDefault();
		formError = '';

		if (!name.trim()) {
			formError = 'Name is required.';
			return;
		}

		await addLocalItem({ name, note, stage: 'todo' });
		name = '';
		note = '';
	}

	async function sendChatMessage() {
		chatError = '';

		const message = chatMessage.trim();
		if (!message) {
			chatError = 'Message is required.';
			return;
		}

		await addLocalItem({
			name: messageTitle(message),
			note: message,
			stage: 'todo'
		});
		chatMessage = '';
	}

	async function handleSendMessage(event: SubmitEvent) {
		event.preventDefault();
		await sendChatMessage();
	}

	function handleChatKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;

		event.preventDefault();
		void sendChatMessage();
	}

	async function handleDeleteConfirmed() {
		if (!pendingDelete) return;

		await deleteLocalItem(pendingDelete.id);
		pendingDelete = null;
		deleteDialogOpen = false;
		void syncNow('manual');
	}

	function requestDelete(item: LocalItem) {
		pendingDelete = item;
		deleteDialogOpen = true;
	}

	function handleDeleteDialogOpenChange(open: boolean) {
		deleteDialogOpen = open;
		if (!open) pendingDelete = null;
	}

	function fieldValue(event: Event) {
		const target = event.currentTarget;
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
			return target.value;
		}
		return '';
	}

	function messageTitle(message: string) {
		const firstLine = message.split('\n').find((line) => line.trim())?.trim() ?? 'Message';
		return firstLine.length > 56 ? `${firstLine.slice(0, 53)}...` : firstLine;
	}

	function handleCardDragStart(event: DragEvent, item: LocalItem) {
		draggedItemId = item.id;
		event.dataTransfer?.setData('text/plain', item.id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function handleCardDragEnd() {
		draggedItemId = null;
		dragOverStage = null;
	}

	async function moveItemToStage(itemId: string | null, stage: KanbanStage | null) {
		if (!itemId || !stage) return;

		const item = $localItems.find((item) => item.id === itemId);
		if (!item || (item.stage ?? 'todo') === stage) return;

		await updateLocalItem(item.id, { stage });
	}

	function stageFromPoint(x: number, y: number) {
		const element = document.elementFromPoint(x, y);
		const dropZone = element?.closest('[data-kanban-stage]');
		if (!(dropZone instanceof HTMLElement)) return null;

		const stage = dropZone.dataset.kanbanStage;
		return kanbanStages.some((item) => item.id === stage) ? (stage as KanbanStage) : null;
	}

	function handleDragHandlePointerDown(event: PointerEvent, item: LocalItem) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;

		draggedItemId = item.id;
		dragOverStage = item.stage ?? 'todo';

		const target = event.currentTarget;
		if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
	}

	function handleDragHandlePointerMove(event: PointerEvent) {
		if (!draggedItemId) return;

		const stage = stageFromPoint(event.clientX, event.clientY);
		if (stage) dragOverStage = stage;
	}

	async function handleDragHandlePointerUp(event: PointerEvent) {
		const itemId = draggedItemId;
		const stage = stageFromPoint(event.clientX, event.clientY);

		draggedItemId = null;
		dragOverStage = null;

		const target = event.currentTarget;
		if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}

		await moveItemToStage(itemId, stage);
	}

	function handleDragHandlePointerCancel() {
		draggedItemId = null;
		dragOverStage = null;
	}

	function handleDragHandleMouseDown(event: MouseEvent, item: LocalItem) {
		if (event.button !== 0) return;

		event.preventDefault();
		draggedItemId = item.id;
		dragOverStage = item.stage ?? 'todo';
	}

	function handleWindowMouseMove(event: MouseEvent) {
		if (!draggedItemId) return;

		const stage = stageFromPoint(event.clientX, event.clientY);
		if (stage) dragOverStage = stage;
	}

	async function handleWindowMouseUp(event: MouseEvent) {
		if (!draggedItemId) return;

		const itemId = draggedItemId;
		const stage = stageFromPoint(event.clientX, event.clientY);

		draggedItemId = null;
		dragOverStage = null;

		await moveItemToStage(itemId, stage);
	}

	function handleColumnDragOver(event: DragEvent, stage: KanbanStage) {
		if (!draggedItemId) return;

		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		dragOverStage = stage;
	}

	function handleColumnDragLeave(event: DragEvent, stage: KanbanStage) {
		const currentTarget = event.currentTarget;
		const relatedTarget = event.relatedTarget;
		if (!(currentTarget instanceof HTMLElement)) return;

		if (!(relatedTarget instanceof Node) || !currentTarget.contains(relatedTarget)) {
			if (dragOverStage === stage) dragOverStage = null;
		}
	}

	async function handleColumnDrop(event: DragEvent, stage: KanbanStage) {
		event.preventDefault();

		const itemId = event.dataTransfer?.getData('text/plain') || draggedItemId;

		draggedItemId = null;
		dragOverStage = null;

		await moveItemToStage(itemId, stage);
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

	function stageItems(items: LocalItem[], stage: KanbanStage) {
		return items.filter((item) => (item.stage ?? 'todo') === stage);
	}

	function chatItems(items: LocalItem[]) {
		return [...items].reverse();
	}

	function stageIndex(stage: KanbanStage) {
		return kanbanStages.findIndex((item) => item.id === stage);
	}

	function nextStage(stage: KanbanStage) {
		return kanbanStages[stageIndex(stage) + 1]?.id;
	}

	function previousStage(stage: KanbanStage) {
		return kanbanStages[stageIndex(stage) - 1]?.id;
	}
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<div class="min-h-dvh bg-background text-foreground">
	<header class="border-b bg-card">
		<div class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
			<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div class="space-y-1">
					<p class="text-xs font-medium text-muted-foreground">SvelteKit + Effect + Local-first</p>
					<h1 class="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">Self Sync</h1>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<Badge
						variant="outline"
						class={cn(
							'h-7 gap-2 rounded-md px-3 text-xs',
							$localSummary.online
								? 'border-emerald-200 bg-emerald-50 text-emerald-800'
								: 'border-amber-200 bg-amber-50 text-amber-800'
						)}
					>
						{#if $localSummary.online}
							<Wifi class="size-3.5" />
							Online
						{:else}
							<WifiOff class="size-3.5" />
							Offline
						{/if}
					</Badge>

					<Button size="lg" onclick={() => syncNow('manual')}>
						<RefreshCw class="size-4" />
						Sync
					</Button>
				</div>
			</div>

			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<Card.Root size="sm">
					<Card.Content>
						<div class="flex items-center justify-between gap-3">
							<p class="text-xs font-medium text-muted-foreground">Local records</p>
							<HardDrive class="size-4 text-muted-foreground" />
						</div>
						<p class="mt-2 text-2xl font-semibold tabular-nums">{$localSummary.total}</p>
					</Card.Content>
				</Card.Root>

				<Card.Root size="sm">
					<Card.Content>
						<div class="flex items-center justify-between gap-3">
							<p class="text-xs font-medium text-muted-foreground">Queued writes</p>
							<Database class="size-4 text-muted-foreground" />
						</div>
						<p class="mt-2 text-2xl font-semibold tabular-nums">{$localSummary.queued}</p>
					</Card.Content>
				</Card.Root>

				<Card.Root size="sm">
					<Card.Content>
						<div class="flex items-center justify-between gap-3">
							<p class="text-xs font-medium text-muted-foreground">Server mode</p>
							<Server class="size-4 text-muted-foreground" />
						</div>
						<p class="mt-2 truncate text-2xl font-semibold">{$localSummary.activity.databaseMode}</p>
					</Card.Content>
				</Card.Root>

				<Card.Root size="sm">
					<Card.Content>
						<div class="flex items-center justify-between gap-3">
							<p class="text-xs font-medium text-muted-foreground">Last sync</p>
							<Cloud class="size-4 text-muted-foreground" />
						</div>
						<p class="mt-2 text-2xl font-semibold tabular-nums">
							{formatTime($localSummary.activity.lastSyncedAt)}
						</p>
					</Card.Content>
				</Card.Root>
			</div>
		</div>
	</header>

	<main
		class="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8"
	>
		<Tabs.Root bind:value={activeTab} class="min-w-0">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<Tabs.List class="w-full sm:w-fit">
					<Tabs.Trigger value="chat" class="gap-2">
						<MessageSquare class="size-4" />
						Chat
					</Tabs.Trigger>
					<Tabs.Trigger value="kanban" class="gap-2">
						<Columns3 class="size-4" />
						Kanban
					</Tabs.Trigger>
				</Tabs.List>

				<p class="text-xs text-muted-foreground">
					{$localSummary.total} records, {$localSummary.queued} queued
				</p>
			</div>

			<Tabs.Content value="chat" class="space-y-4">
				<Card.Root>
					<Card.Header>
						<Card.Title>Chat</Card.Title>
						<Card.Description>
							Messages are local-first records and appear on the kanban board as To do cards.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						<div class="max-h-[52rem] space-y-3 overflow-y-auto rounded-md bg-muted/30 p-3">
							{#if $localItems.length === 0}
								<div class="rounded-md border border-dashed bg-background px-4 py-8 text-center">
									<p class="text-sm font-medium">No messages yet</p>
									<p class="mt-1 text-xs text-muted-foreground">
										Send the first message and it will sync locally.
									</p>
								</div>
							{:else}
								{#each chatItems($localItems) as item (item.id)}
									<div class="flex gap-3">
										<div
											class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
										>
											SS
										</div>
										<div class="min-w-0 flex-1 rounded-md border bg-background px-3 py-2">
											<div class="flex flex-wrap items-center justify-between gap-2">
												<p class="truncate text-sm font-medium">{item.name}</p>
												<Badge
													variant="outline"
													class={cn(
														'h-5 gap-1 rounded-md px-2',
														item.syncStatus === 'synced' &&
															'border-emerald-200 bg-emerald-50 text-emerald-800',
														item.syncStatus === 'pending' &&
															'border-amber-200 bg-amber-50 text-amber-800',
														item.syncStatus === 'error' && 'border-red-200 bg-red-50 text-red-800'
													)}
												>
													{statusLabel(item)}
												</Badge>
											</div>
											<p class="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
												{item.note || item.name}
											</p>
										</div>
									</div>
								{/each}
							{/if}
						</div>

						<form class="space-y-2" onsubmit={handleSendMessage}>
							<Label for="chat-message">Message</Label>
							<div class="flex flex-col gap-2 sm:flex-row">
								<Input
									id="chat-message"
									bind:value={chatMessage}
									class="h-9"
									autocomplete="off"
									onkeydown={handleChatKeydown}
									placeholder="Type a message and press Enter"
									type="text"
								/>
								<Button type="submit" size="lg" class="h-9 w-full sm:w-auto">
									<Send class="size-4" />
									Send
								</Button>
							</div>
							{#if chatError}
								<p class="text-sm text-destructive">{chatError}</p>
							{:else}
								<p class="text-xs text-muted-foreground">Enter sends. New messages start in To do.</p>
							{/if}
						</form>
					</Card.Content>
				</Card.Root>
			</Tabs.Content>

			<Tabs.Content value="kanban" class="space-y-4">
				<Card.Root>
					<Card.Content>
						<form onsubmit={handleAdd}>
							<div class="grid gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)_auto]">
								<div class="grid gap-1.5">
									<Label for="item-name">Card</Label>
									<Input
										id="item-name"
										bind:value={name}
										class="h-9"
										placeholder="Card title"
										type="text"
									/>
								</div>

								<div class="grid gap-1.5">
									<Label for="item-note">Note</Label>
									<Input
										id="item-note"
										bind:value={note}
										class="h-9"
										placeholder="Optional note"
										type="text"
									/>
								</div>

								<Button type="submit" size="lg" class="h-9 w-full md:mt-auto md:w-auto">
									<Plus class="size-4" />
									Add card
								</Button>
							</div>

							{#if formError}
								<p class="mt-2 text-sm text-destructive">{formError}</p>
							{/if}
						</form>
					</Card.Content>
				</Card.Root>

				<div class="grid gap-4 xl:grid-cols-3">
					{#each kanbanStages as stage}
						<section
							class={cn(
								'flex min-w-0 flex-col rounded-lg border bg-muted/20 p-3',
								dragOverStage === stage.id && 'border-primary bg-muted/40'
							)}
						>
							<div class="mb-3 flex items-start justify-between gap-3">
								<div>
									<h2 class="text-sm font-medium">{stage.label}</h2>
									<p class="mt-1 text-xs text-muted-foreground">{stage.description}</p>
								</div>
								<Badge variant="secondary" class="rounded-md">
									{stageItems($localItems, stage.id).length}
								</Badge>
							</div>

							<div
								role="list"
								aria-label={`${stage.label} cards`}
								data-kanban-stage={stage.id}
								class="flex min-h-72 flex-1 flex-col gap-3 rounded-md"
								ondragover={(event) => handleColumnDragOver(event, stage.id)}
								ondragleave={(event) => handleColumnDragLeave(event, stage.id)}
								ondrop={(event) => handleColumnDrop(event, stage.id)}
							>
								{#if stageItems($localItems, stage.id).length === 0}
									<div
										class={cn(
											'grid min-h-28 place-items-center rounded-md border border-dashed bg-background/60 px-3 py-6 text-center',
											dragOverStage === stage.id && 'border-primary bg-background'
										)}
									>
										<p class="text-xs text-muted-foreground">Drop a card here</p>
									</div>
								{:else}
									{#each stageItems($localItems, stage.id) as item (item.id)}
										<Card.Root
											size="sm"
											role="listitem"
											aria-label={`${item.name} card`}
											class={cn(draggedItemId === item.id && 'opacity-60')}
										>
											<Card.Content class="space-y-3">
												<div class="flex items-start gap-2">
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														class="mt-0.5 cursor-grab text-muted-foreground active:cursor-grabbing"
														aria-label={`Drag ${item.name}`}
														draggable="true"
														ondragstart={(event) => handleCardDragStart(event, item)}
														ondragend={handleCardDragEnd}
														onmousedown={(event) => handleDragHandleMouseDown(event, item)}
														onpointerdown={(event) => handleDragHandlePointerDown(event, item)}
														onpointermove={handleDragHandlePointerMove}
														onpointerup={handleDragHandlePointerUp}
														onpointercancel={handleDragHandlePointerCancel}
													>
														<GripVertical class="size-4" />
													</Button>
													<div class="min-w-0 flex-1 space-y-2">
														<Input
															class="h-9 bg-muted/40 text-sm font-medium"
															value={item.name}
															oninput={(event) =>
																updateLocalItem(item.id, {
																	name: fieldValue(event)
																})}
														/>
														<Textarea
															class="min-h-20 resize-y bg-muted/40 text-sm leading-6"
															value={item.note}
															oninput={(event) =>
																updateLocalItem(item.id, {
																	note: fieldValue(event)
																})}
														/>
													</div>
												</div>

												<div class="flex flex-wrap items-center justify-between gap-2">
													<Badge
														variant="outline"
														class={cn(
															'h-7 gap-2 rounded-md px-2.5',
															item.syncStatus === 'synced' &&
																'border-emerald-200 bg-emerald-50 text-emerald-800',
															item.syncStatus === 'pending' &&
																'border-amber-200 bg-amber-50 text-amber-800',
															item.syncStatus === 'error' &&
																'border-red-200 bg-red-50 text-red-800'
														)}
													>
														{#if item.syncStatus === 'synced'}
															<CheckCircle2 class="size-3.5" />
														{:else}
															<AlertCircle class="size-3.5" />
														{/if}
														{statusLabel(item)}
													</Badge>

													<div class="flex items-center gap-1">
														<Button
															type="button"
															variant="outline"
															size="icon"
															aria-label={`Move ${item.name} left`}
															disabled={!previousStage(item.stage ?? 'todo')}
															onclick={() => {
																const previous = previousStage(item.stage ?? 'todo');
																if (previous) void updateLocalItem(item.id, { stage: previous });
															}}
														>
															<ArrowLeft class="size-3.5" />
														</Button>
														<Button
															type="button"
															variant="outline"
															size="icon"
															aria-label={`Move ${item.name} right`}
															disabled={!nextStage(item.stage ?? 'todo')}
															onclick={() => {
																const next = nextStage(item.stage ?? 'todo');
																if (next) void updateLocalItem(item.id, { stage: next });
															}}
														>
															<ArrowRight class="size-3.5" />
														</Button>
														<Button
															type="button"
															variant="outline"
															size="icon"
															aria-label={`Delete ${item.name}`}
															title="Delete"
															onclick={() => requestDelete(item)}
														>
															<Trash2 class="size-3.5" />
														</Button>
													</div>
												</div>

												{#if item.lastError}
													<p
														class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
													>
														{item.lastError}
													</p>
												{/if}
											</Card.Content>
										</Card.Root>
									{/each}
								{/if}
							</div>
						</section>
					{/each}
				</div>
			</Tabs.Content>
		</Tabs.Root>

		<aside class="space-y-4">
			<Card.Root>
				<Card.Header>
					<div class="flex items-center justify-between gap-3">
						<Card.Title>Sync status</Card.Title>
						<Badge
							variant="outline"
							class={cn(
								'rounded-md capitalize',
								$localSummary.activity.status === 'synced' && 'bg-emerald-50 text-emerald-800',
								$localSummary.activity.status === 'syncing' && 'bg-sky-50 text-sky-800',
								$localSummary.activity.status === 'offline' && 'bg-amber-50 text-amber-800',
								$localSummary.activity.status === 'error' && 'bg-red-50 text-red-800',
								$localSummary.activity.status === 'idle' && 'bg-muted text-muted-foreground'
							)}
						>
							{$localSummary.activity.status}
						</Badge>
					</div>
					<Card.Description>{$localSummary.activity.lastMessage}</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-3">
					{#if $localSummary.activity.error}
						<p class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							{$localSummary.activity.error}
						</p>
					{/if}

					<Separator />

					<div class="rounded-md bg-muted/50 px-3 py-2">
						<div class="flex items-center justify-between gap-3">
							<p class="text-sm font-medium">Realtime</p>
							<Badge
								variant="outline"
								class={cn(
									'rounded-md capitalize',
									$realtimeActivity.status === 'connected' && 'bg-emerald-50 text-emerald-800',
									$realtimeActivity.status === 'connecting' && 'bg-sky-50 text-sky-800',
									$realtimeActivity.status === 'disconnected' && 'bg-amber-50 text-amber-800',
									$realtimeActivity.status === 'error' && 'bg-red-50 text-red-800'
								)}
							>
								{$realtimeActivity.status}
							</Badge>
						</div>
						<p class="mt-1 text-pretty text-xs text-muted-foreground">{$realtimeActivity.message}</p>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Outbox</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-2">
					{#if $outboxItems.length === 0}
						<p class="rounded-md bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
							No queued writes.
						</p>
					{:else}
						{#each $outboxItems as mutation (mutation.id)}
							<div class="rounded-md border px-3 py-2">
								<div class="flex items-center justify-between gap-3">
									<p class="truncate text-sm font-medium">{mutation.item.name}</p>
									<Badge variant="secondary" class="rounded-md">{mutation.op}</Badge>
								</div>
								<p class="mt-1 text-xs text-muted-foreground tabular-nums">
									Attempts: {mutation.attempts}
								</p>
							</div>
						{/each}
					{/if}
				</Card.Content>
			</Card.Root>
		</aside>
	</main>
</div>

<Dialog.Root bind:open={deleteDialogOpen} onOpenChange={handleDeleteDialogOpenChange}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete record</Dialog.Title>
			<Dialog.Description>
				This queues a delete mutation for {pendingDelete?.name ?? 'this record'}.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button
				type="button"
				variant="outline"
				onclick={() => handleDeleteDialogOpenChange(false)}
			>
				Cancel
			</Button>
			<Button type="button" variant="destructive" onclick={handleDeleteConfirmed}>Delete</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
