import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { DatabaseMode } from '../shared/types';

const { Client, Pool } = pg;
const REALTIME_CHANNEL = 'sync_items_changed';

export interface RealtimeSyncMessage {
	type: 'sync_changed';
	id: string;
	sourceClientId: string;
	itemIds: string[];
	databaseMode: DatabaseMode;
	serverTime: number;
}

type RealtimeListener = (message: RealtimeSyncMessage) => void;

interface RealtimeConnectionOptions {
	publishDatabaseUrl?: string;
	listenDatabaseUrl?: string;
}

type RealtimeGlobal = typeof globalThis & {
	__localFirstRealtimeEmitter?: EventEmitter;
	__localFirstRealtimeNotifyPool?: InstanceType<typeof Pool>;
	__localFirstRealtimeNotifyPoolKey?: string;
};

function getGlobal() {
	return globalThis as RealtimeGlobal;
}

function getEmitter() {
	const currentGlobal = getGlobal();
	currentGlobal.__localFirstRealtimeEmitter ??= new EventEmitter();
	currentGlobal.__localFirstRealtimeEmitter.setMaxListeners(1000);
	return currentGlobal.__localFirstRealtimeEmitter;
}

function getPublishDatabaseUrl(options: RealtimeConnectionOptions = {}) {
	return options.publishDatabaseUrl || process.env.DATABASE_URL;
}

function getListenDatabaseUrl(options: RealtimeConnectionOptions = {}) {
	return (
		options.listenDatabaseUrl ||
		process.env.DATABASE_URL_UNPOOLED ||
		process.env.POSTGRES_URL_NON_POOLING ||
		process.env.DATABASE_URL
	);
}

function isPostgresConnectionString(connectionString: string | undefined): connectionString is string {
	return /^postgres(?:ql)?:\/\//i.test(connectionString ?? '');
}

function getNotifyPool(connectionString: string) {
	const currentGlobal = getGlobal();

	if (
		currentGlobal.__localFirstRealtimeNotifyPool &&
		currentGlobal.__localFirstRealtimeNotifyPoolKey === connectionString
	) {
		return currentGlobal.__localFirstRealtimeNotifyPool;
	}

	currentGlobal.__localFirstRealtimeNotifyPool = new Pool({ connectionString });
	currentGlobal.__localFirstRealtimeNotifyPoolKey = connectionString;
	return currentGlobal.__localFirstRealtimeNotifyPool;
}

function parseMessage(payload: string | undefined) {
	if (!payload) return null;

	try {
		const parsed = JSON.parse(payload) as RealtimeSyncMessage;
		return parsed.type === 'sync_changed' ? parsed : null;
	} catch {
		return null;
	}
}

export async function publishSyncChange(
	input: Omit<RealtimeSyncMessage, 'id' | 'type'>,
	options: RealtimeConnectionOptions = {}
) {
	const message: RealtimeSyncMessage = {
		...input,
		type: 'sync_changed',
		id: randomUUID()
	};

	getEmitter().emit(REALTIME_CHANNEL, message);

	const connectionString = getPublishDatabaseUrl(options);
	if (!isPostgresConnectionString(connectionString)) return;

	try {
		await getNotifyPool(connectionString).query('select pg_notify($1, $2)', [
			REALTIME_CHANNEL,
			JSON.stringify(message)
		]);
	} catch (error) {
		console.error('Failed to publish realtime sync notification', error);
	}
}

export async function subscribeSyncChanges(
	listener: RealtimeListener,
	options: RealtimeConnectionOptions = {}
) {
	const emitter = getEmitter();
	emitter.on(REALTIME_CHANNEL, listener);

	const connectionString = getListenDatabaseUrl(options);
	if (!isPostgresConnectionString(connectionString)) {
		return () => {
			emitter.off(REALTIME_CHANNEL, listener);
		};
	}

	const client = new Client({ connectionString });

	try {
		await client.connect();
		await client.query(`listen ${REALTIME_CHANNEL}`);
		client.on('notification', (notification) => {
			const message = parseMessage(notification.payload);
			if (message) listener(message);
		});
	} catch (error) {
		console.error('Failed to subscribe to realtime sync notifications', error);
		await client.end().catch(() => {});

		return () => {
			emitter.off(REALTIME_CHANNEL, listener);
		};
	}

	return async () => {
		emitter.off(REALTIME_CHANNEL, listener);
		await client.query(`unlisten ${REALTIME_CHANNEL}`).catch(() => {});
		await client.end().catch(() => {});
	};
}
