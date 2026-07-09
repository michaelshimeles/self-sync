# Self Sync

Self Sync is a fast local-first sync framework built with SvelteKit, Effect, IndexedDB, WebSockets, and SQL-backed storage.

This repository is a rewrite of the original React/Hono demo into a focused sync-engine app with:

- SvelteKit 2 / Svelte 5
- Effect for request validation and server-side sync programs
- Dexie / IndexedDB as the reactive local source of truth
- Postgres or MySQL storage adapters
- WebSocket invalidation for low-latency cross-tab and cross-client sync
- Memory storage fallback for zero-config local development

## What it does

- Writes to IndexedDB first so the UI updates immediately.
- Uses an outbox to batch create, edit, and delete mutations.
- Syncs in the background, on reconnect, through a manual sync button, and when realtime invalidations arrive.
- Validates sync requests with Effect Schema before touching storage.
- Supports Postgres and MySQL with the same server-side sync contract.
- Resolves stale writes deterministically with `updatedAt`, `revision`, and idempotent mutation IDs.
- Keeps deletes local-first by writing tombstones to IndexedDB, syncing them immediately, and merging server tombstones back into the local database.

## Run

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The app runs without a database by default.

## Database

The app works without a database by using an in-memory server store. For durable sync, set `DATABASE_URL`.

Postgres:

```sh
DATABASE_DRIVER=postgres
DATABASE_URL=postgres://user:password@localhost:5432/local_first
```

MySQL:

```sh
DATABASE_DRIVER=mysql
DATABASE_URL=mysql://user:password@localhost:3306/local_first
```

The server creates the `sync_items` table automatically on first use. The raw SQL is also available in:

- `src/lib/server/sql/schema.postgres.sql`
- `src/lib/server/sql/schema.mysql.sql`

## Realtime sync

The app keeps IndexedDB as the render source and uses WebSockets as an invalidation channel. When `POST /api/sync` applies a create, update, or delete, the server publishes a `sync_changed` message. Connected clients that did not originate the change immediately run `syncNow('realtime')` and merge the authoritative server snapshot into Dexie.

Local development uses a Vite WebSocket plugin at:

```text
ws://localhost:5173/api/realtime
```

Production on Vercel uses the Node function in `api/realtime.ts`:

```text
wss://your-domain.com/api/realtime
```

For Postgres deployments, the realtime broker uses Postgres `LISTEN/NOTIFY` so WebSocket clients connected to different function instances still receive invalidations. Use an unpooled connection string for listening when your provider supplies one:

```sh
DATABASE_URL_UNPOOLED=postgres://user:password@host:5432/local_first
# or
POSTGRES_URL_NON_POOLING=postgres://user:password@host:5432/local_first
```

MySQL still syncs correctly through the local-first outbox and background pull loop. Cross-instance realtime for MySQL should use an external pub/sub service such as Redis, Ably, Pusher, or a MySQL binlog-based bridge.

On Vercel, WebSockets require Fluid Compute. New projects have it enabled by default, but older projects may need it enabled in project settings.

## API

- `POST /api/sync` applies queued mutations and returns authoritative server state.
- `GET /api/items` returns non-deleted server items.
- `GET /api/health` reports the active storage mode.
- `GET /api/realtime` upgrades to a WebSocket connection for realtime sync invalidations.

## Architecture

Local writes go to IndexedDB first and enqueue a single latest mutation per item in the outbox. The UI renders from Dexie `liveQuery`, so creates, edits, and deletes update immediately without waiting for the network.

`POST /api/sync` runs an Effect program that validates the request, applies queued mutations through the selected storage adapter, and returns the authoritative server state. The client merges that response back into IndexedDB and clears completed outbox mutations.

Conflict handling is deterministic: newer `updatedAt` wins, stale mutations are marked as reconciled, and mutation IDs make retries idempotent. WebSockets do not carry item payloads; they only wake clients up so every device converges through the same sync endpoint.
