import http from 'node:http';
import pg from 'pg';
import { WebSocket, WebSocketServer } from 'ws';

const { Client } = pg;
const REALTIME_CHANNEL = 'sync_items_changed';

type DatabaseMode = 'memory' | 'postgres' | 'mysql';

interface RealtimeSyncMessage {
	type: 'sync_changed';
	id: string;
	sourceClientId: string;
	itemIds: string[];
	databaseMode: DatabaseMode;
	serverTime: number;
}

type RealtimeListener = (message: RealtimeSyncMessage) => void;

const server = http.createServer((_request, response) => {
	response.writeHead(426, { 'content-type': 'text/plain' });
	response.end('Expected WebSocket upgrade');
});
const wss = new WebSocketServer({ server });

let unsubscribePromise: Promise<(() => void | Promise<void>) | null> | null = null;

function getListenDatabaseUrl() {
	return (
		process.env.DATABASE_URL_UNPOOLED ||
		process.env.POSTGRES_URL_NON_POOLING ||
		process.env.DATABASE_URL
	);
}

function isPostgresConnectionString(connectionString: string | undefined): connectionString is string {
	return /^postgres(?:ql)?:\/\//i.test(connectionString ?? '');
}

function normalisePostgresConnectionString(connectionString: string) {
	try {
		const url = new URL(connectionString);
		const sslMode = url.searchParams.get('sslmode')?.toLowerCase();

		if (sslMode === 'prefer' || sslMode === 'require' || sslMode === 'verify-ca') {
			url.searchParams.set('sslmode', 'verify-full');
			return url.toString();
		}
	} catch {
		return connectionString;
	}

	return connectionString;
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

async function subscribeSyncChanges(listener: RealtimeListener) {
	const connectionString = getListenDatabaseUrl();
	if (!isPostgresConnectionString(connectionString)) {
		console.warn('Realtime WebSocket started without a Postgres connection string');
		return () => {};
	}

	const client = new Client({ connectionString: normalisePostgresConnectionString(connectionString) });

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
		return () => {};
	}

	return async () => {
		await client.query(`unlisten ${REALTIME_CHANNEL}`).catch(() => {});
		await client.end().catch(() => {});
	};
}

function broadcast(message: RealtimeSyncMessage) {
	const payload = JSON.stringify(message);

	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(payload);
		}
	}
}

function ensureSubscribed() {
	unsubscribePromise ??= subscribeSyncChanges(broadcast).catch((error) => {
		console.error('Failed to start realtime WebSocket subscription', error);
		unsubscribePromise = null;
		return null;
	});

	return unsubscribePromise;
}

wss.on('connection', (socket) => {
	void ensureSubscribed().then(() => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'connected', serverTime: Date.now() }));
		}
	});
});

wss.on('close', async () => {
	const unsubscribe = await unsubscribePromise;
	await unsubscribe?.();
	unsubscribePromise = null;
});

export default server;
