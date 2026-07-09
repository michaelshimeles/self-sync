import { browser } from '$app/environment';
import { getClientId } from './identity';
import { db } from './local-db';
import { markOutboxFailed, realtimeActivity, syncActivity } from './local-store';
import type { LocalItem, OutboxMutation, ServerItem, SyncChange, SyncResponse } from '$lib/shared/types';

let syncInFlight = false;
type SyncReason = 'manual' | 'interval' | 'online' | 'startup' | 'realtime';

function toLocalItem(item: ServerItem): LocalItem {
	return {
		...item,
		syncStatus: 'synced',
		lastError: null
	};
}

async function mergeServerItems(items: ServerItem[], sent: OutboxMutation[], response: SyncResponse) {
	const completedMutationIds = new Set(response.applied.map((outcome) => outcome.mutationId));
	const serverItemIds = new Set(items.map((item) => item.id));

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

		const localRows = await db.items.toArray();
		await Promise.all(
			localRows.map(async (item) => {
				if (
					item.syncStatus === 'synced' &&
					!serverItemIds.has(item.id) &&
					!pendingItemIds.has(item.id)
				) {
					await db.items.delete(item.id);
				}
			})
		);
	});
}

export async function syncNow(reason: SyncReason = 'manual') {
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
		lastMessage:
			reason === 'manual'
				? 'Syncing now'
				: reason === 'realtime'
					? 'Realtime change received'
					: 'Background sync',
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

function realtimeUrl() {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const clientId = encodeURIComponent(getClientId());
	return `${protocol}//${window.location.host}/api/realtime?clientId=${clientId}`;
}

function startRealtimeConnection() {
	if (!browser) return () => {};

	let socket: WebSocket | null = null;
	let reconnectTimer: number | null = null;
	let stopped = false;
	let reconnectAttempt = 0;
	const seenMessages = new Set<string>();

	const scheduleReconnect = () => {
		if (stopped || reconnectTimer !== null) return;

		const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
		reconnectAttempt += 1;
		realtimeActivity.set({
			status: 'disconnected',
			lastConnectedAt: null,
			lastMessageAt: null,
			message: `Realtime reconnecting in ${Math.round(delay / 1000)}s`
		});

		reconnectTimer = window.setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, delay);
	};

	const connect = () => {
		if (stopped) return;

		realtimeActivity.update((state) => ({
			...state,
			status: 'connecting',
			message: 'Connecting realtime'
		}));

		socket = new WebSocket(realtimeUrl());

		socket.addEventListener('open', () => {
			reconnectAttempt = 0;
			realtimeActivity.set({
				status: 'connected',
				lastConnectedAt: Date.now(),
				lastMessageAt: null,
				message: 'Realtime connected'
			});
		});

		socket.addEventListener('message', (event) => {
			if (typeof event.data !== 'string') return;

			try {
				const message = JSON.parse(event.data) as {
					type?: string;
					id?: string;
					sourceClientId?: string;
				};

				if (message.type === 'connected') return;
				if (message.type !== 'sync_changed' || !message.id) return;
				if (seenMessages.has(message.id)) return;

				seenMessages.add(message.id);
				if (seenMessages.size > 200) {
					seenMessages.clear();
				}

				realtimeActivity.update((state) => ({
					...state,
					status: 'connected',
					lastMessageAt: Date.now(),
					message:
						message.sourceClientId === getClientId()
							? 'Realtime confirmed local sync'
							: 'Realtime change received'
				}));

				if (message.sourceClientId !== getClientId()) {
					void syncNow('realtime');
				}
			} catch (error) {
				console.error('Invalid realtime message', error);
			}
		});

		socket.addEventListener('close', () => {
			socket = null;
			scheduleReconnect();
		});

		socket.addEventListener('error', () => {
			realtimeActivity.update((state) => ({
				...state,
				status: 'error',
				message: 'Realtime connection failed'
			}));
			socket?.close();
		});
	};

	connect();

	return () => {
		stopped = true;
		if (reconnectTimer !== null) {
			window.clearTimeout(reconnectTimer);
		}
		socket?.close();
	};
}

export function startSyncLoop() {
	if (!browser) return () => {};

	const sync = (reason: 'interval' | 'online') => void syncNow(reason);
	const interval = window.setInterval(() => sync('interval'), 4000);
	const stopRealtime = startRealtimeConnection();
	const onlineHandler = () => sync('online');
	const visibilityHandler = () => {
		if (document.visibilityState === 'visible') sync('interval');
	};

	window.addEventListener('online', onlineHandler);
	document.addEventListener('visibilitychange', visibilityHandler);
	void syncNow('startup');

	return () => {
		window.clearInterval(interval);
		stopRealtime();
		window.removeEventListener('online', onlineHandler);
		document.removeEventListener('visibilitychange', visibilityHandler);
	};
}
