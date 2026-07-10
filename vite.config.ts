import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { subscribeSyncChanges, type RealtimeSyncMessage } from './src/lib/server/realtime';

function realtimeWebSocketPlugin(options: { listenDatabaseUrl?: string } = {}): Plugin {
	return {
		name: 'local-first-realtime-websocket',
		configureServer(server) {
			if (!server.httpServer) return;

			const wss = new WebSocketServer({ noServer: true });
			let unsubscribePromise: Promise<(() => void | Promise<void>) | null> | null = null;

			const broadcast = (message: RealtimeSyncMessage) => {
				const payload = JSON.stringify(message);

				for (const client of wss.clients) {
					if (client.readyState === WebSocket.OPEN) {
						client.send(payload);
					}
				}
			};

			unsubscribePromise = subscribeSyncChanges(broadcast, options).catch((error) => {
				console.error('Failed to start local realtime WebSocket subscription', error);
				return null;
			});

			server.httpServer.on('upgrade', (request, socket, head) => {
				if (!request.url) return;

				const { pathname } = new URL(request.url, 'http://localhost');
				if (pathname !== '/api/realtime') return;

				wss.handleUpgrade(request, socket, head, (webSocket) => {
					wss.emit('connection', webSocket, request);
				});
			});

			wss.on('connection', (socket) => {
				socket.send(JSON.stringify({ type: 'connected', serverTime: Date.now() }));
			});

			server.httpServer.on('close', async () => {
				const unsubscribe = await unsubscribePromise;
				await unsubscribe?.();
				wss.close();
			});
		}
	};
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const databaseDriver = (
		process.env.DATABASE_DRIVER ??
		process.env.DB_DRIVER ??
		env.DATABASE_DRIVER ??
		env.DB_DRIVER ??
		''
	).toLowerCase();
	const configuredDatabaseUrl =
		process.env.DATABASE_URL !== undefined ? process.env.DATABASE_URL : env.DATABASE_URL;
	const listenDatabaseUrl =
		databaseDriver === 'memory'
			? undefined
			: process.env.DATABASE_URL_UNPOOLED ||
				process.env.POSTGRES_URL_NON_POOLING ||
				env.DATABASE_URL_UNPOOLED ||
				env.POSTGRES_URL_NON_POOLING ||
				configuredDatabaseUrl;

	return {
		plugins: [
			realtimeWebSocketPlugin({ listenDatabaseUrl }),
			tailwindcss(),
			sveltekit()
		]
	};
});
