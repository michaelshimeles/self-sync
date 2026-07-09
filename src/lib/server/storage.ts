import { env } from '$env/dynamic/private';
import mysql from 'mysql2/promise';
import pg from 'pg';
import type { RowDataPacket } from 'mysql2/promise';
import type {
	DatabaseMode,
	ServerItem,
	SyncChange,
	SyncOutcome,
	SyncRequest,
	SyncResponse
} from '$lib/shared/types';

const { Pool } = pg;

interface StoredItem extends ServerItem {
	lastMutationId: string | null;
}

export interface SyncStorage {
	mode: DatabaseMode;
	listItems(options?: { includeDeleted?: boolean }): Promise<ServerItem[]>;
	applyChanges(request: SyncRequest): Promise<SyncResponse>;
}

function normaliseIncoming(change: SyncChange): ServerItem {
	const now = Date.now();

	return {
		id: change.item.id,
		name: change.item.name.trim() || 'Untitled',
		note: change.item.note,
		revision: 0,
		updatedAt: change.item.updatedAt || now,
		deletedAt: change.op === 'delete' ? (change.item.deletedAt ?? now) : change.item.deletedAt,
		sourceClientId: null
	};
}

function toServerItem(item: StoredItem): ServerItem {
	return {
		id: item.id,
		name: item.name,
		note: item.note,
		revision: item.revision,
		updatedAt: item.updatedAt,
		deletedAt: item.deletedAt,
		sourceClientId: item.sourceClientId
	};
}

function sortItems(items: ServerItem[]) {
	return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

class MemoryStorage implements SyncStorage {
	mode: DatabaseMode = 'memory';
	private store: Map<string, StoredItem>;

	constructor(store: Map<string, StoredItem>) {
		this.store = store;
	}

	async listItems(options: { includeDeleted?: boolean } = {}) {
		const rows = [...this.store.values()]
			.filter((item) => options.includeDeleted || item.deletedAt === null)
			.map(toServerItem);

		return sortItems(rows);
	}

	async applyChanges(request: SyncRequest): Promise<SyncResponse> {
		const applied: SyncOutcome[] = [];

		for (const change of request.changes) {
			const incoming = normaliseIncoming(change);
			const current = this.store.get(incoming.id);

			if (current?.lastMutationId === change.mutationId) {
				applied.push({
					mutationId: change.mutationId,
					itemId: incoming.id,
					status: 'duplicate',
					revision: current.revision
				});
				continue;
			}

			if (current && current.updatedAt > incoming.updatedAt) {
				applied.push({
					mutationId: change.mutationId,
					itemId: incoming.id,
					status: 'conflict',
					revision: current.revision
				});
				continue;
			}

			const next: StoredItem = {
				...incoming,
				revision: (current?.revision ?? 0) + 1,
				sourceClientId: request.clientId,
				lastMutationId: change.mutationId
			};

			this.store.set(next.id, next);
			applied.push({
				mutationId: change.mutationId,
				itemId: next.id,
				status: 'applied',
				revision: next.revision
			});
		}

		return {
			serverTime: Date.now(),
			databaseMode: this.mode,
			applied,
			items: await this.listItems({ includeDeleted: true })
		};
	}
}

const postgresSchema = `
create table if not exists sync_items (
	id text primary key,
	name text not null,
	note text not null default '',
	revision integer not null default 0,
	updated_at bigint not null,
	deleted_at bigint,
	source_client_id text,
	last_mutation_id text
);
create index if not exists sync_items_updated_at_idx on sync_items (updated_at desc);
`;

function fromPostgresRow(row: Record<string, unknown>): StoredItem {
	return {
		id: String(row.id),
		name: String(row.name),
		note: String(row.note ?? ''),
		revision: Number(row.revision),
		updatedAt: Number(row.updated_at),
		deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
		sourceClientId: row.source_client_id === null ? null : String(row.source_client_id),
		lastMutationId: row.last_mutation_id === null ? null : String(row.last_mutation_id)
	};
}

class PostgresStorage implements SyncStorage {
	mode: DatabaseMode = 'postgres';
	private pool: InstanceType<typeof Pool>;
	private ready = false;

	constructor(connectionString: string) {
		this.pool = new Pool({ connectionString });
	}

	private async ensureSchema() {
		if (this.ready) return;
		await this.pool.query(postgresSchema);
		this.ready = true;
	}

	async listItems(options: { includeDeleted?: boolean } = {}) {
		await this.ensureSchema();

		const result = await this.pool.query(
			`select * from sync_items
			 ${options.includeDeleted ? '' : 'where deleted_at is null'}
			 order by updated_at desc`
		);

		return result.rows.map(fromPostgresRow).map(toServerItem);
	}

	async applyChanges(request: SyncRequest): Promise<SyncResponse> {
		await this.ensureSchema();
		const client = await this.pool.connect();
		const applied: SyncOutcome[] = [];

		try {
			await client.query('begin');

			for (const change of request.changes) {
				const incoming = normaliseIncoming(change);
				const currentResult = await client.query('select * from sync_items where id = $1 for update', [
					incoming.id
				]);
				const current = currentResult.rows[0] ? fromPostgresRow(currentResult.rows[0]) : null;

				if (current?.lastMutationId === change.mutationId) {
					applied.push({
						mutationId: change.mutationId,
						itemId: incoming.id,
						status: 'duplicate',
						revision: current.revision
					});
					continue;
				}

				if (current && current.updatedAt > incoming.updatedAt) {
					applied.push({
						mutationId: change.mutationId,
						itemId: incoming.id,
						status: 'conflict',
						revision: current.revision
					});
					continue;
				}

				const nextRevision = (current?.revision ?? 0) + 1;

				if (current) {
					await client.query(
						`update sync_items
						 set name = $2, note = $3, revision = $4, updated_at = $5, deleted_at = $6,
						 source_client_id = $7, last_mutation_id = $8
						 where id = $1`,
						[
							incoming.id,
							incoming.name,
							incoming.note,
							nextRevision,
							incoming.updatedAt,
							incoming.deletedAt,
							request.clientId,
							change.mutationId
						]
					);
				} else {
					await client.query(
						`insert into sync_items
						 (id, name, note, revision, updated_at, deleted_at, source_client_id, last_mutation_id)
						 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
						[
							incoming.id,
							incoming.name,
							incoming.note,
							nextRevision,
							incoming.updatedAt,
							incoming.deletedAt,
							request.clientId,
							change.mutationId
						]
					);
				}

				applied.push({
					mutationId: change.mutationId,
					itemId: incoming.id,
					status: 'applied',
					revision: nextRevision
				});
			}

			await client.query('commit');
		} catch (error) {
			await client.query('rollback');
			throw error;
		} finally {
			client.release();
		}

		return {
			serverTime: Date.now(),
			databaseMode: this.mode,
			applied,
			items: await this.listItems({ includeDeleted: true })
		};
	}
}

const mysqlSchema = `
create table if not exists sync_items (
	id varchar(64) primary key,
	name text not null,
	note text not null,
	revision int not null default 0,
	updated_at bigint not null,
	deleted_at bigint null,
	source_client_id varchar(128) null,
	last_mutation_id varchar(128) null,
	index sync_items_updated_at_idx (updated_at desc)
);
`;

type MySqlRow = RowDataPacket & {
	id: string;
	name: string;
	note: string;
	revision: number;
	updated_at: number | string;
	deleted_at: number | string | null;
	source_client_id: string | null;
	last_mutation_id: string | null;
};

function fromMySqlRow(row: MySqlRow): StoredItem {
	return {
		id: row.id,
		name: row.name,
		note: row.note ?? '',
		revision: Number(row.revision),
		updatedAt: Number(row.updated_at),
		deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
		sourceClientId: row.source_client_id,
		lastMutationId: row.last_mutation_id
	};
}

class MySqlStorage implements SyncStorage {
	mode: DatabaseMode = 'mysql';
	private pool: mysql.Pool;
	private ready = false;

	constructor(uri: string) {
		this.pool = mysql.createPool({ uri, namedPlaceholders: false });
	}

	private async ensureSchema() {
		if (this.ready) return;
		await this.pool.query(mysqlSchema);
		this.ready = true;
	}

	async listItems(options: { includeDeleted?: boolean } = {}) {
		await this.ensureSchema();

		const [rows] = await this.pool.query<MySqlRow[]>(
			`select * from sync_items
			 ${options.includeDeleted ? '' : 'where deleted_at is null'}
			 order by updated_at desc`
		);

		return rows.map(fromMySqlRow).map(toServerItem);
	}

	async applyChanges(request: SyncRequest): Promise<SyncResponse> {
		await this.ensureSchema();
		const connection = await this.pool.getConnection();
		const applied: SyncOutcome[] = [];

		try {
			await connection.beginTransaction();

			for (const change of request.changes) {
				const incoming = normaliseIncoming(change);
				const [rows] = await connection.query<MySqlRow[]>(
					'select * from sync_items where id = ? for update',
					[incoming.id]
				);
				const current = rows[0] ? fromMySqlRow(rows[0]) : null;

				if (current?.lastMutationId === change.mutationId) {
					applied.push({
						mutationId: change.mutationId,
						itemId: incoming.id,
						status: 'duplicate',
						revision: current.revision
					});
					continue;
				}

				if (current && current.updatedAt > incoming.updatedAt) {
					applied.push({
						mutationId: change.mutationId,
						itemId: incoming.id,
						status: 'conflict',
						revision: current.revision
					});
					continue;
				}

				const nextRevision = (current?.revision ?? 0) + 1;

				if (current) {
					await connection.query(
						`update sync_items
						 set name = ?, note = ?, revision = ?, updated_at = ?, deleted_at = ?,
						 source_client_id = ?, last_mutation_id = ?
						 where id = ?`,
						[
							incoming.name,
							incoming.note,
							nextRevision,
							incoming.updatedAt,
							incoming.deletedAt,
							request.clientId,
							change.mutationId,
							incoming.id
						]
					);
				} else {
					await connection.query(
						`insert into sync_items
						 (id, name, note, revision, updated_at, deleted_at, source_client_id, last_mutation_id)
						 values (?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							incoming.id,
							incoming.name,
							incoming.note,
							nextRevision,
							incoming.updatedAt,
							incoming.deletedAt,
							request.clientId,
							change.mutationId
						]
					);
				}

				applied.push({
					mutationId: change.mutationId,
					itemId: incoming.id,
					status: 'applied',
					revision: nextRevision
				});
			}

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}

		return {
			serverTime: Date.now(),
			databaseMode: this.mode,
			applied,
			items: await this.listItems({ includeDeleted: true })
		};
	}
}

const globalStore = globalThis as typeof globalThis & {
	__sveltekitEffectLocalFirstStore?: Map<string, StoredItem>;
};

let storageSingleton: SyncStorage | null = null;
let storageKey = '';

export function getStorage(): SyncStorage {
	const connectionString = env.DATABASE_URL;
	const explicitDriver = (env.DATABASE_DRIVER || env.DB_DRIVER || '').toLowerCase();
	const driver =
		explicitDriver ||
		(connectionString?.startsWith('mysql') ? 'mysql' : connectionString ? 'postgres' : 'memory');
	const nextKey = `${driver}:${connectionString ?? 'memory'}`;

	if (storageSingleton && storageKey === nextKey) return storageSingleton;

	if (!connectionString || driver === 'memory') {
		globalStore.__sveltekitEffectLocalFirstStore ??= new Map();
		storageSingleton = new MemoryStorage(globalStore.__sveltekitEffectLocalFirstStore);
		storageKey = nextKey;
		return storageSingleton;
	}

	if (driver === 'mysql') {
		storageSingleton = new MySqlStorage(connectionString);
		storageKey = nextKey;
		return storageSingleton;
	}

	storageSingleton = new PostgresStorage(connectionString);
	storageKey = nextKey;
	return storageSingleton;
}
