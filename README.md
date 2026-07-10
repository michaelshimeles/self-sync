# Self Sync

Self Sync is a local-first sync framework for SvelteKit and Effect.

It gives you instant local UI, atomic multi-record mutations, durable SQL-backed sync, and realtime convergence without making realtime the source of truth. Apps transact against IndexedDB first, queue whole transactions while offline, sync to Postgres or MySQL when a connection is available, and use WebSockets to wake up other clients after commits land.

In one line:

> Local-first UX, SQL durability, realtime convergence.

Live app: https://sveltekit-effect-local-first-sync.vercel.app

## How To Explain It

Self Sync is both local-first and realtime, but local-first is the core.

Realtime is the acceleration layer. It does not carry authoritative app state or replace sync. It only tells connected clients that something changed, then each client pulls through the same sync endpoint and merges the result into its local database.

That means the app stays useful offline, feels instant while online, and still converges across tabs, browsers, and devices.

## What This Gives You

- **Instant UI:** reads and writes hit IndexedDB first, and Svelte updates from Dexie `liveQuery`.
- **Offline writes:** creates, edits, drag/drop moves, and deletes queue locally when the network is unavailable.
- **Transactions as a primitive:** related reads, writes, and outbox entries commit together locally and remain one atomic unit on the server.
- **Durable sync:** the server persists records in Postgres or MySQL through a shared sync contract.
- **Realtime convergence:** WebSockets send invalidations so other clients pull fresh state immediately.
- **Deterministic conflict handling:** Effect validates requests, a transaction ledger makes retries idempotent, revisions and timestamps resolve stale writes, and tombstones make deletes sync correctly.
- **Zero-config development:** memory storage works locally without a database.

## Mental Model

```text
User action
  -> localTransaction(...)
  -> atomic IndexedDB writes + grouped outbox entry
  -> reactive Svelte UI update
  -> POST /api/sync
  -> serializable Postgres/MySQL transaction
  -> WebSocket invalidation
  -> other clients pull and merge
```

The local database is the render source. SQL is the durable shared source. WebSockets are only the notification path.

## Transactions

Every mutation is a transaction. The built-in `addLocalItem`, `updateLocalItem`, and `deleteLocalItem` helpers each create a single-write transaction. Domain operations can group multiple reads and writes explicitly:

```ts
import { localTransaction } from '$lib/client/local-store';

await localTransaction(async (tx) => {
	const first = await tx.get(firstCardId);
	const second = await tx.get(secondCardId);

	if (!first || !second) throw new Error('Both cards are required');

	await tx.patch(first.id, { stage: 'doing' });
	await tx.patch(second.id, { stage: 'done' });
});
```

The callback reads one consistent IndexedDB snapshot. If it throws, none of its local records or outbox entries are written. If it succeeds, Dexie commits the records and their shared transaction ID together, so reactive readers never observe a partial local mutation.

At sync time, Self Sync preserves that boundary. Postgres and MySQL use serializable SQL transactions, lock touched rows in a stable order, commit all writes with an idempotency ledger, and automatically retry serialization or deadlock failures. A domain conflict rejects the whole transaction; the server never applies only some of its writes.

Keep transaction callbacks deterministic and limited to local database work. Do not perform `fetch`, email, payment, or other external side effects inside them.

### How This Differs From Convex

The programming model is intentionally Convex-like: the mutation is the transaction, writes are atomic, retries are idempotent, and reactive clients update after commit.

The offline boundary is the important difference. Convex runs a mutation against the latest server snapshot and can rerun its deterministic function after an optimistic concurrency conflict. Self Sync commits immediately against the device's local snapshot, possibly while offline. When that transaction reaches shared SQL later, the server can retry database serialization failures automatically, but it cannot safely rerun the original domain function because the outbox currently carries its resulting writes rather than the function and arguments. A stale domain transaction is therefore rejected and reconciled as one unit.

## Demo App

The demo shows the framework with two views over the same synced records:

- **Chat:** type a message and press Enter. The message appears immediately and syncs in the background.
- **Kanban:** cards can be edited, deleted, and dragged between Trello-style columns. Moves are local-first mutations and sync like any other write.

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

The server creates the `sync_items` and `sync_transactions` tables automatically on first use. The raw schema files are also available in:

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

- `POST /api/sync` atomically applies queued transaction envelopes and returns authoritative server state.
- `GET /api/items` returns non-deleted server items.
- `GET /api/health` reports the active storage mode.
- `GET /api/realtime` upgrades to a WebSocket connection for realtime sync invalidations.

## Sync Model

Local writes update IndexedDB first and enqueue a transaction envelope in the outbox. Repeated unsynced single-item edits are compacted, while multi-item transaction boundaries are preserved. The UI renders from Dexie `liveQuery`, so creates, edits, and deletes appear immediately without waiting for the network.

`POST /api/sync` runs an Effect program that validates the request, applies each queued transaction through the selected storage adapter, and returns the authoritative server state. The client merges that response back into IndexedDB and atomically clears completed outbox transactions.

Conflict handling is deterministic: newer `updatedAt` wins, equal timestamps use client and mutation IDs as a stable tie-breaker, and the transaction ledger makes retries idempotent. Deletes are tombstones, not hard local removals, so offline deletes sync correctly and other clients converge through the same merge path.

## Vercel Notes

The production deployment uses Vercel Fluid Compute for WebSockets. New Vercel projects have Fluid Compute enabled by default; older projects may need it enabled in project settings.

The public production domain is:

```text
https://sveltekit-effect-local-first-sync.vercel.app
```
