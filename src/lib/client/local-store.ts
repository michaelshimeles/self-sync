import { browser } from '$app/environment';
import { liveQuery } from 'dexie';
import { derived, readable, writable } from 'svelte/store';
import { getClientId } from './identity';
import { db } from './local-db';
import {
	runLocalTransaction,
	type ItemPatch,
	type LocalTransactionContext,
	type LocalTransactionResult
} from './local-transaction';
import type {
	KanbanStage,
	LocalItem,
	OutboxMutation,
	RealtimeActivity,
	SyncActivity
} from '$lib/shared/types';

export type { ItemPatch, LocalTransactionContext, LocalTransactionResult } from './local-transaction';

function dexieReadable<T>(query: () => Promise<T>, initialValue: T) {
	if (!browser) return readable(initialValue);

	return readable(initialValue, (set) => {
		const subscription = liveQuery(query).subscribe({
			next: set,
			error: (error) => console.error('Dexie live query failed', error)
		});

		return () => subscription.unsubscribe();
	});
}

export const localItems = dexieReadable<LocalItem[]>(
	async () => {
		const rows = await db.items.orderBy('updatedAt').reverse().toArray();
		return rows.filter((item) => item.deletedAt === null);
	},
	[]
);

export const tombstones = dexieReadable<LocalItem[]>(
	async () => {
		const rows = await db.items.orderBy('updatedAt').reverse().toArray();
		return rows.filter((item) => item.deletedAt !== null);
	},
	[]
);

export const outboxItems = dexieReadable<OutboxMutation[]>(
	() => db.outbox.orderBy('createdAt').toArray(),
	[]
);

export const online = readable(true, (set) => {
	if (!browser) return;

	const update = () => set(navigator.onLine);
	update();

	window.addEventListener('online', update);
	window.addEventListener('offline', update);

	return () => {
		window.removeEventListener('online', update);
		window.removeEventListener('offline', update);
	};
});

export const syncActivity = writable<SyncActivity>({
	status: 'idle',
	lastSyncedAt: null,
	lastMessage: 'Local database ready',
	error: null,
	databaseMode: 'unknown'
});

export const realtimeActivity = writable<RealtimeActivity>({
	status: 'disconnected',
	lastConnectedAt: null,
	lastMessageAt: null,
	message: 'Realtime not connected'
});

export const localSummary = derived(
	[localItems, tombstones, outboxItems, online, syncActivity],
	([$items, $tombstones, $outbox, $online, $activity]) => ({
		total: $items.length,
		tombstones: $tombstones.length,
		queued: $outbox.length,
		pending: $items.filter((item) => item.syncStatus === 'pending').length,
		errors: $items.filter((item) => item.syncStatus === 'error').length,
		online: $online,
		activity: $activity
	})
);

export async function localTransaction<T>(
	handler: (transaction: LocalTransactionContext) => T | Promise<T>
): Promise<LocalTransactionResult<T>> {
	return runLocalTransaction({ db, clientId: getClientId() }, handler);
}

export async function addLocalItem(input: { name: string; note: string; stage?: KanbanStage }) {
	const name = input.name.trim();
	if (!name) return;

	const result = await localTransaction((transaction) =>
		transaction.insert({ ...input, name })
	);
	return result.value;
}

export async function updateLocalItem(id: string, patch: ItemPatch) {
	const result = await localTransaction((transaction) => transaction.patch(id, patch));
	return result.value;
}

export async function deleteLocalItem(id: string) {
	const result = await localTransaction((transaction) => transaction.delete(id));
	return result.value;
}

export async function markOutboxFailed(message: string) {
	await db.transaction('rw', db.items, db.outbox, async () => {
		const pending = await db.outbox.toArray();

		await Promise.all(
			pending.map(async (mutation) => {
				await db.outbox.update(mutation.id, {
					attempts: mutation.attempts + 1,
					lastError: message
				});
				await db.items.update(mutation.itemId, {
					syncStatus: 'error',
					lastError: message
				});
			})
		);
	});
}
