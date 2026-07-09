import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-vercel';
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
	const listenDatabaseUrl =
		env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL;

	return {
		plugins: [
			realtimeWebSocketPlugin({ listenDatabaseUrl }),
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				adapter: adapter()
			})
		]
	};
});
