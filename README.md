# SvelteKit Effect Local-First Sync

Fast local-first app starter built with SvelteKit, Effect, IndexedDB, and a SQL-backed sync engine.

This repository is a rewrite of the original React/Hono demo into a focused sync-engine app with:

- SvelteKit 2 / Svelte 5
- Effect for request validation and server-side sync programs
- Dexie / IndexedDB as the reactive local source of truth
- Postgres or MySQL storage adapters
- Memory storage fallback for zero-config local development

## What it does

- Writes to IndexedDB first so the UI updates immediately.
- Uses an outbox to batch create, edit, and delete mutations.
- Syncs in the background, on reconnect, and through a manual sync button.
- Validates sync requests with Effect Schema before touching storage.
- Supports Postgres and MySQL with the same server-side sync contract.
- Resolves stale writes deterministically with `updatedAt`, `revision`, and idempotent mutation IDs.

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

## API

- `POST /api/sync` applies queued mutations and returns authoritative server state.
- `GET /api/items` returns non-deleted server items.
- `GET /api/health` reports the active storage mode.

## Architecture

Local writes go to IndexedDB first and enqueue a single latest mutation per item in the outbox. The UI renders from Dexie `liveQuery`, so creates, edits, and deletes update immediately without waiting for the network.

`POST /api/sync` runs an Effect program that validates the request, applies queued mutations through the selected storage adapter, and returns the authoritative server state. The client merges that response back into IndexedDB and clears completed outbox mutations.

Conflict handling is deterministic: newer `updatedAt` wins, stale mutations are marked as reconciled, and mutation IDs make retries idempotent.
