import { browser } from '$app/environment';
import { getClientId } from './identity';
import { db } from './local-db';
import { markOutboxFailed, syncActivity } from './local-store';
import type { LocalItem, OutboxMutation, ServerItem, SyncChange, SyncResponse } from '$lib/shared/types';

let syncInFlight = false;

function toLocalItem(item: ServerItem): LocalItem {
	return {
		...item,
		syncStatus: 'synced',
		lastError: null
	};
}

async function mergeServerItems(items: ServerItem[], sent: OutboxMutation[], response: SyncResponse) {
	const completedMutationIds = new Set(response.applied.map((outcome) => outcome.mutationId));

	await db.transaction('rw', db.items, db.outbox, async () => {
		await Promise.all([...completedMutationIds].map((id) => db.outbox.delete(id)));

		const stillPending = await db.outbox.toArray();
		const pendingItemIds = new Set(stillPending.map((mutation) => mutation.itemId));
		const sentItemIds = new Set(sent.map((mutation) => mutation.itemId));

		for (const item of items) {
			if (pendingItemIds.has(item.id)) continue;

			if (item.deletedAt !== null) {
				await db.items.delete(item.id);
				continue;
			}

			const local = await db.items.get(item.id);
			const localIsNewer = local && sentItemIds.has(item.id) && local.updatedAt > item.updatedAt;
			if (localIsNewer) continue;

			await db.items.put(toLocalItem(item));
		}
	});
}

export async function syncNow(reason: 'manual' | 'interval' | 'online' | 'startup' = 'manual') {
	if (!browser || syncInFlight) return;

	if (!navigator.onLine) {
		syncActivity.set({
			status: 'offline',
			lastSyncedAt: null,
			lastMessage: 'Offline',
			error: null,
			databaseMode: 'unknown'
		});
		return;
	}

	syncInFlight = true;
	syncActivity.update((state) => ({
		...state,
		status: 'syncing',
		lastMessage: reason === 'manual' ? 'Syncing now' : 'Background sync',
		error: null
	}));

	try {
		const queued = await db.outbox.orderBy('createdAt').toArray();
		const changes: SyncChange[] = queued.map((mutation) => ({
			mutationId: mutation.id,
			op: mutation.op,
			item: mutation.item
		}));

		const response = await fetch('/api/sync', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				clientId: getClientId(),
				changes
			})
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(body || `Sync failed with ${response.status}`);
		}

		const payload = (await response.json()) as SyncResponse;
		await mergeServerItems(payload.items, queued, payload);

		const appliedCount = payload.applied.filter((outcome) => outcome.status !== 'conflict').length;
		const conflictCount = payload.applied.filter((outcome) => outcome.status === 'conflict').length;

		syncActivity.set({
			status: 'synced',
			lastSyncedAt: Date.now(),
			lastMessage:
				queued.length === 0
					? 'Pulled latest server state'
					: `${appliedCount} synced${conflictCount ? `, ${conflictCount} reconciled` : ''}`,
			error: null,
			databaseMode: payload.databaseMode
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Sync failed';
		await markOutboxFailed(message);

		syncActivity.update((state) => ({
			...state,
			status: 'error',
			lastMessage: 'Sync failed',
			error: message
		}));
	} finally {
		syncInFlight = false;
	}
}

export function startSyncLoop() {
	if (!browser) return () => {};

	const sync = (reason: 'interval' | 'online') => void syncNow(reason);
	const interval = window.setInterval(() => sync('interval'), 4000);
	const onlineHandler = () => sync('online');
	const visibilityHandler = () => {
		if (document.visibilityState === 'visible') sync('interval');
	};

	window.addEventListener('online', onlineHandler);
	document.addEventListener('visibilitychange', visibilityHandler);
	void syncNow('startup');

	return () => {
		window.clearInterval(interval);
		window.removeEventListener('online', onlineHandler);
		document.removeEventListener('visibilitychange', visibilityHandler);
	};
}
