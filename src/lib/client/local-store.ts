import { browser } from '$app/environment';
import { liveQuery } from 'dexie';
import { derived, readable, writable } from 'svelte/store';
import { getClientId } from './identity';
import { db } from './local-db';
import type {
	ClientSyncItem,
	LocalItem,
	MutationOperation,
	OutboxMutation,
	RealtimeActivity,
	SyncActivity
} from '$lib/shared/types';

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

function toSyncItem(item: LocalItem): ClientSyncItem {
	return {
		id: item.id,
		name: item.name,
		note: item.note,
		updatedAt: item.updatedAt,
		deletedAt: item.deletedAt
	};
}

function createMutation(op: MutationOperation, item: LocalItem): OutboxMutation {
	return {
		id: crypto.randomUUID(),
		itemId: item.id,
		op,
		item: toSyncItem(item),
		createdAt: Date.now(),
		attempts: 0,
		lastError: null
	};
}

async function putLocalChange(item: LocalItem, op: MutationOperation) {
	const mutation = createMutation(op, item);

	await db.transaction('rw', db.items, db.outbox, async () => {
		await db.items.put(item);
		await db.outbox.where('itemId').equals(item.id).delete();
		await db.outbox.add(mutation);
	});
}

export async function addLocalItem(input: { name: string; note: string }) {
	const now = Date.now();
	const name = input.name.trim();
	const note = input.note.trim();

	if (!name) return;

	const item: LocalItem = {
		id: crypto.randomUUID(),
		name,
		note,
		revision: 0,
		updatedAt: now,
		deletedAt: null,
		sourceClientId: getClientId(),
		syncStatus: 'pending',
		lastError: null
	};

	await putLocalChange(item, 'upsert');
}

export async function updateLocalItem(id: string, patch: Partial<Pick<LocalItem, 'name' | 'note'>>) {
	const existing = await db.items.get(id);
	if (!existing || existing.deletedAt !== null) return;

	const item: LocalItem = {
		...existing,
		...patch,
		name: patch.name ?? existing.name,
		note: patch.note ?? existing.note,
		updatedAt: Date.now(),
		sourceClientId: getClientId(),
		syncStatus: 'pending',
		lastError: null
	};

	await putLocalChange(item, 'upsert');
}

export async function deleteLocalItem(id: string) {
	const existing = await db.items.get(id);
	if (!existing) return;

	const now = Date.now();
	const item: LocalItem = {
		...existing,
		updatedAt: now,
		deletedAt: now,
		sourceClientId: getClientId(),
		syncStatus: 'pending',
		lastError: null
	};

	await putLocalChange(item, 'delete');
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
