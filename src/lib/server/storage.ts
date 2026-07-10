import { env } from '$env/dynamic/private';
import mysql from 'mysql2/promise';
import pg from 'pg';
import type { RowDataPacket } from 'mysql2/promise';
import type {
	DatabaseMode,
	ServerItem,
	SyncRequest,
	SyncResponse,
	SyncTransaction,
	SyncTransactionOutcome
} from '$lib/shared/types';
import {
	normaliseStage,
	planSyncTransaction,
	sortItems,
	toServerItem,
	type StoredSyncItem,
	type TerminalTransactionStatus,
	type TransactionPlan
} from './transaction';

const { Pool } = pg;
const MAX_TRANSACTION_ATTEMPTS = 4;

export interface SyncStorage {
	mode: DatabaseMode;
	listItems(options?: { includeDeleted?: boolean }): Promise<ServerItem[]>;
	applyChanges(request: SyncRequest): Promise<SyncResponse>;
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

function makeResponse(
	mode: DatabaseMode,
	plans: TransactionPlan[],
	items: ServerItem[]
): SyncResponse {
	return {
		serverTime: Date.now(),
		databaseMode: mode,
		transactions: plans.map((plan) => plan.transaction),
		applied: plans.flatMap((plan) => plan.outcomes),
		items
	};
}

function transactionKey(clientId: string, transactionId: string) {
	return `${clientId}\u0000${transactionId}`;
}

class MemoryStorage implements SyncStorage {
	mode: DatabaseMode = 'memory';

	constructor(
		private store: Map<string, StoredSyncItem>,
		private transactions: Map<string, TerminalTransactionStatus>
	) {}

	async listItems(options: { includeDeleted?: boolean } = {}) {
		const rows = [...this.store.values()]
			.filter((item) => options.includeDeleted || item.deletedAt === null)
			.map(toServerItem);

		return sortItems(rows);
	}

	private applyTransaction(clientId: string, transaction: SyncTransaction) {
		const currentItems = new Map<string, StoredSyncItem>();
		for (const change of transaction.changes) {
			const current = this.store.get(change.item.id);
			if (current) currentItems.set(current.id, current);
		}

		const key = transactionKey(clientId, transaction.id);
		const plan = planSyncTransaction({
			clientId,
			transaction,
			currentItems,
			terminalStatus: this.transactions.get(key)
		});

		if (plan.status === 'applied') {
			for (const item of plan.writes) this.store.set(item.id, item);
		}

		if (plan.recordStatus) this.transactions.set(key, plan.recordStatus);
		return plan;
	}

	async applyChanges(request: SyncRequest): Promise<SyncResponse> {
		const plans = request.transactions.map((transaction) =>
			this.applyTransaction(request.clientId, transaction)
		);

		return makeResponse(this.mode, plans, await this.listItems({ includeDeleted: true }));
	}
}

const postgresSchema = `
create table if not exists sync_items (
	id text primary key,
	name text not null,
	note text not null default '',
	stage text not null default 'todo',
	revision integer not null default 0,
	updated_at bigint not null,
	deleted_at bigint,
	source_client_id text,
	last_mutation_id text
);
alter table sync_items add column if not exists stage text not null default 'todo';
create index if not exists sync_items_updated_at_idx on sync_items (updated_at desc);
create table if not exists sync_transactions (
	client_id text not null,
	id text not null,
	status text not null check (status in ('applied', 'conflict')),
	committed_at bigint not null,
	primary key (client_id, id)
);
`;

function fromPostgresRow(row: Record<string, unknown>): StoredSyncItem {
	return {
		id: String(row.id),
		name: String(row.name),
		note: String(row.note ?? ''),
		stage: normaliseStage(row.stage),
		revision: Number(row.revision),
		updatedAt: Number(row.updated_at),
		deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
		sourceClientId: row.source_client_id === null ? null : String(row.source_client_id),
		lastMutationId: row.last_mutation_id === null ? null : String(row.last_mutation_id)
	};
}

function postgresErrorCode(error: unknown) {
	return typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
}

function isRetryablePostgresError(error: unknown) {
	return ['40001', '40P01', '23505'].includes(postgresErrorCode(error));
}

class PostgresStorage implements SyncStorage {
	mode: DatabaseMode = 'postgres';
	private pool: InstanceType<typeof Pool>;
	private ready = false;

	constructor(connectionString: string) {
		this.pool = new Pool({
			connectionString: normalisePostgresConnectionString(connectionString)
		});
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

	private async applyTransaction(clientId: string, transaction: SyncTransaction) {
		for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
			const client = await this.pool.connect();
			let transactionStarted = false;

			try {
				await client.query('begin isolation level serializable');
				transactionStarted = true;

				const ledgerResult = await client.query(
					`select status from sync_transactions where client_id = $1 and id = $2 for update`,
					[clientId, transaction.id]
				);
				const terminalStatus = ledgerResult.rows[0]?.status as
					| TerminalTransactionStatus
					| undefined;
				const itemIds = [...new Set(transaction.changes.map((change) => change.item.id))].sort();
				const itemResult =
					itemIds.length === 0
						? { rows: [] as Record<string, unknown>[] }
						: await client.query(
								`select * from sync_items where id = any($1::text[]) order by id for update`,
								[itemIds]
							);
				const currentItems = new Map(
					itemResult.rows.map((row) => {
						const item = fromPostgresRow(row);
						return [item.id, item] as const;
					})
				);
				const plan = planSyncTransaction({
					clientId,
					transaction,
					currentItems,
					terminalStatus
				});

				for (const item of plan.writes) {
					if (currentItems.has(item.id)) {
						await client.query(
							`update sync_items
							 set name = $2, note = $3, stage = $4, revision = $5, updated_at = $6,
							 deleted_at = $7, source_client_id = $8, last_mutation_id = $9
							 where id = $1`,
							[
								item.id,
								item.name,
								item.note,
								item.stage,
								item.revision,
								item.updatedAt,
								item.deletedAt,
								item.sourceClientId,
								item.lastMutationId
							]
						);
					} else {
						await client.query(
							`insert into sync_items
							 (id, name, note, stage, revision, updated_at, deleted_at, source_client_id, last_mutation_id)
							 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
							[
								item.id,
								item.name,
								item.note,
								item.stage,
								item.revision,
								item.updatedAt,
								item.deletedAt,
								item.sourceClientId,
								item.lastMutationId
							]
						);
					}
				}

				if (plan.recordStatus) {
					const ledgerInsert = await client.query(
						`insert into sync_transactions (client_id, id, status, committed_at)
						 values ($1, $2, $3, $4)
						 on conflict (client_id, id) do nothing`,
						[clientId, transaction.id, plan.recordStatus, Date.now()]
					);
					if (ledgerInsert.rowCount !== 1) {
						const error = new Error('Concurrent transaction ledger write');
						Object.assign(error, { code: '40001' });
						throw error;
					}
				}

				await client.query('commit');
				return plan;
			} catch (error) {
				if (transactionStarted) {
					try {
						await client.query('rollback');
					} catch {
						// Preserve the original transaction failure.
					}
				}

				if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryablePostgresError(error)) continue;
				throw error;
			} finally {
				client.release();
			}
		}

		throw new Error(`Transaction ${transaction.id} exhausted its retry budget`);
	}

	async applyChanges(request: SyncRequest): Promise<SyncResponse> {
		await this.ensureSchema();
		const plans: TransactionPlan[] = [];

		for (const transaction of request.transactions) {
			plans.push(await this.applyTransaction(request.clientId, transaction));
		}

		return makeResponse(this.mode, plans, await this.listItems({ includeDeleted: true }));
	}
}

const mysqlItemsSchema = `
create table if not exists sync_items (
	id varchar(64) primary key,
	name text not null,
	note text not null,
	stage varchar(16) not null default 'todo',
	revision int not null default 0,
	updated_at bigint not null,
	deleted_at bigint null,
	source_client_id varchar(128) null,
	last_mutation_id varchar(128) null,
	index sync_items_updated_at_idx (updated_at desc)
)
`;

const mysqlTransactionsSchema = `
create table if not exists sync_transactions (
	client_id varchar(128) not null,
	id varchar(128) not null,
	status varchar(16) not null,
	committed_at bigint not null,
	primary key (client_id, id)
)
`;

type MySqlItemRow = RowDataPacket & {
	id: string;
	name: string;
	note: string;
	stage?: string | null;
	revision: number;
	updated_at: number | string;
	deleted_at: number | string | null;
	source_client_id: string | null;
	last_mutation_id: string | null;
};

type MySqlTransactionRow = RowDataPacket & {
	status: TerminalTransactionStatus;
};

function fromMySqlRow(row: MySqlItemRow): StoredSyncItem {
	return {
		id: row.id,
		name: row.name,
		note: row.note ?? '',
		stage: normaliseStage(row.stage),
		revision: Number(row.revision),
		updatedAt: Number(row.updated_at),
		deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
		sourceClientId: row.source_client_id,
		lastMutationId: row.last_mutation_id
	};
}

function mysqlErrorDetails(error: unknown) {
	if (typeof error !== 'object' || !error) return { code: '', errno: 0, sqlState: '' };
	return {
		code: 'code' in error ? String(error.code) : '',
		errno: 'errno' in error ? Number(error.errno) : 0,
		sqlState: 'sqlState' in error ? String(error.sqlState) : ''
	};
}

function isRetryableMySqlError(error: unknown) {
	const details = mysqlErrorDetails(error);
	return (
		['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'].includes(details.code) ||
		[1205, 1213, 1062].includes(details.errno) ||
		details.sqlState === '40001'
	);
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
		await this.pool.query(mysqlItemsSchema);
		await this.pool.query(mysqlTransactionsSchema);

		try {
			await this.pool.query(
				`alter table sync_items add column stage varchar(16) not null default 'todo'`
			);
		} catch (error) {
			if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) throw error;
		}

		this.ready = true;
	}

	async listItems(options: { includeDeleted?: boolean } = {}) {
		await this.ensureSchema();
		const [rows] = await this.pool.query<MySqlItemRow[]>(
			`select * from sync_items
			 ${options.includeDeleted ? '' : 'where deleted_at is null'}
			 order by updated_at desc`
		);

		return rows.map(fromMySqlRow).map(toServerItem);
	}

	private async applyTransaction(clientId: string, transaction: SyncTransaction) {
		for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
			const connection = await this.pool.getConnection();
			let transactionStarted = false;

			try {
				await connection.query('set transaction isolation level serializable');
				await connection.beginTransaction();
				transactionStarted = true;

				const [ledgerRows] = await connection.query<MySqlTransactionRow[]>(
					`select status from sync_transactions where client_id = ? and id = ? for update`,
					[clientId, transaction.id]
				);
				const terminalStatus = ledgerRows[0]?.status;
				const itemIds = [...new Set(transaction.changes.map((change) => change.item.id))].sort();
				let itemRows: MySqlItemRow[] = [];

				if (itemIds.length > 0) {
					const placeholders = itemIds.map(() => '?').join(', ');
					[itemRows] = await connection.query<MySqlItemRow[]>(
						`select * from sync_items where id in (${placeholders}) order by id for update`,
						itemIds
					);
				}

				const currentItems = new Map(
					itemRows.map((row) => {
						const item = fromMySqlRow(row);
						return [item.id, item] as const;
					})
				);
				const plan = planSyncTransaction({
					clientId,
					transaction,
					currentItems,
					terminalStatus
				});

				for (const item of plan.writes) {
					if (currentItems.has(item.id)) {
						await connection.query(
							`update sync_items
							 set name = ?, note = ?, stage = ?, revision = ?, updated_at = ?, deleted_at = ?,
							 source_client_id = ?, last_mutation_id = ? where id = ?`,
							[
								item.name,
								item.note,
								item.stage,
								item.revision,
								item.updatedAt,
								item.deletedAt,
								item.sourceClientId,
								item.lastMutationId,
								item.id
							]
						);
					} else {
						await connection.query(
							`insert into sync_items
							 (id, name, note, stage, revision, updated_at, deleted_at, source_client_id, last_mutation_id)
							 values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							[
								item.id,
								item.name,
								item.note,
								item.stage,
								item.revision,
								item.updatedAt,
								item.deletedAt,
								item.sourceClientId,
								item.lastMutationId
							]
						);
					}
				}

				if (plan.recordStatus) {
					await connection.query(
						`insert into sync_transactions (client_id, id, status, committed_at) values (?, ?, ?, ?)`,
						[clientId, transaction.id, plan.recordStatus, Date.now()]
					);
				}

				await connection.commit();
				return plan;
			} catch (error) {
				if (transactionStarted) {
					try {
						await connection.rollback();
					} catch {
						// Preserve the original transaction failure.
					}
				}

				if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryableMySqlError(error)) continue;
				throw error;
			} finally {
				connection.release();
			}
		}

		throw new Error(`Transaction ${transaction.id} exhausted its retry budget`);
	}

	async applyChanges(request: SyncRequest): Promise<SyncResponse> {
		await this.ensureSchema();
		const plans: TransactionPlan[] = [];

		for (const transaction of request.transactions) {
			plans.push(await this.applyTransaction(request.clientId, transaction));
		}

		return makeResponse(this.mode, plans, await this.listItems({ includeDeleted: true }));
	}
}

const globalStore = globalThis as typeof globalThis & {
	__selfSyncStore?: Map<string, StoredSyncItem>;
	__selfSyncTransactions?: Map<string, TerminalTransactionStatus>;
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
		globalStore.__selfSyncStore ??= new Map();
		globalStore.__selfSyncTransactions ??= new Map();
		storageSingleton = new MemoryStorage(
			globalStore.__selfSyncStore,
			globalStore.__selfSyncTransactions
		);
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
