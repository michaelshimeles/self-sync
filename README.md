# Self Sync

Self Sync is a local-first sync engine for SvelteKit and Effect. It keeps the UI reactive from IndexedDB, writes offline-first through an outbox, syncs to SQL storage, and uses WebSockets to wake up other clients as changes land.

Live app: https://sveltekit-effect-local-first-sync.vercel.app

## What This Proves

- A SvelteKit app can feel instant because reads and writes hit local IndexedDB first.
- Chat and kanban views can share the same local-first records and stay reactive through Dexie `liveQuery`.
- Creates, edits, and deletes work offline, queue locally, and converge after reconnect.
- Server sync can stay deterministic with Effect Schema validation, idempotent mutation IDs, revisions, timestamps, and delete tombstones.
- Realtime can stay simple: WebSockets only send invalidations, then every client pulls through the same sync endpoint.
- Postgres and MySQL can use the same sync contract, with memory storage available for zero-config local development.

## Stack

- SvelteKit 2 and Svelte 5
- Effect for request validation and server-side sync programs
- Dexie and IndexedDB as the reactive local source of truth
- WebSockets for low-latency cross-client invalidation
- Postgres or MySQL storage adapters
- Vercel Fluid Compute for production WebSocket support

## Run Locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. No database is required for local development; the server falls back to an in-memory store.

## Configure SQL

Set `DATABASE_URL` to make sync durable.

Postgres:

```sh
DATABASE_DRIVER=postgres
DATABASE_URL=postgres://user:password@localhost:5432/self_sync
```

MySQL:

```sh
DATABASE_DRIVER=mysql
DATABASE_URL=mysql://user:password@localhost:3306/self_sync
```

The server creates the `sync_items` table automatically on first use. The raw schema files are also available in:

- `src/lib/server/sql/schema.postgres.sql`
- `src/lib/server/sql/schema.mysql.sql`

## Realtime

The app keeps IndexedDB as the render source and uses WebSockets as an invalidation channel. When `POST /api/sync` applies a create, update, or delete, the server publishes `sync_changed`. Connected clients that did not originate the change immediately run `syncNow('realtime')` and merge the authoritative server state into Dexie.

Local development uses the Vite WebSocket plugin:

```text
ws://localhost:5173/api/realtime
```

Production uses the Vercel function:

```text
wss://sveltekit-effect-local-first-sync.vercel.app/api/realtime
```

For Postgres deployments, the realtime broker uses `LISTEN/NOTIFY` so clients connected to different function instances still receive invalidations. Use an unpooled connection string for listening when your provider supplies one:

```sh
DATABASE_URL_UNPOOLED=postgres://user:password@host:5432/self_sync
# or
POSTGRES_URL_NON_POOLING=postgres://user:password@host:5432/self_sync
```

MySQL sync still works through the outbox and background pull loop. Cross-instance realtime for MySQL should use an external pub/sub service such as Redis, Ably, Pusher, or a binlog-backed bridge.

## API

- `POST /api/sync` applies queued mutations and returns authoritative server state.
- `GET /api/items` returns non-deleted server items.
- `GET /api/health` reports the active storage mode.
- `GET /api/realtime` upgrades to a WebSocket connection for realtime sync invalidations.

## Sync Model

Local writes update IndexedDB first and enqueue a latest mutation per item in the outbox. The UI renders from Dexie `liveQuery`, so creates, edits, and deletes appear immediately without waiting for the network.

`POST /api/sync` runs an Effect program that validates the request, applies queued mutations through the selected storage adapter, and returns the authoritative server state. The client merges that response back into IndexedDB and clears completed outbox mutations.

Conflict handling is deterministic: newer `updatedAt` wins, stale mutations are reconciled, and mutation IDs make retries idempotent. Deletes are tombstones, not hard local removals, so offline deletes sync correctly and other clients converge through the same merge path.

## Vercel Notes

The production deployment uses Vercel Fluid Compute for WebSockets. New Vercel projects have Fluid Compute enabled by default; older projects may need it enabled in project settings.

The public production domain is:

```text
https://sveltekit-effect-local-first-sync.vercel.app
```
