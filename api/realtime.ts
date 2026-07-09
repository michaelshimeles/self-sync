import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { subscribeSyncChanges, type RealtimeSyncMessage } from '../src/lib/server/realtime';

const server = http.createServer();
const wss = new WebSocketServer({ server });

let unsubscribePromise: Promise<(() => void | Promise<void>) | null> | null = null;

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
}

wss.on('connection', (socket) => {
	ensureSubscribed();
	socket.send(JSON.stringify({ type: 'connected', serverTime: Date.now() }));
});

wss.on('close', async () => {
	const unsubscribe = await unsubscribePromise;
	await unsubscribe?.();
	unsubscribePromise = null;
});

export default server;
