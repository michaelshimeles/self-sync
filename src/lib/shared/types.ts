export type SyncStatus = 'synced' | 'pending' | 'error';
export type MutationOperation = 'upsert' | 'delete';
export type DatabaseMode = 'memory' | 'postgres' | 'mysql';
export type KanbanStage = 'todo' | 'doing' | 'done';

export interface ServerItem {
	id: string;
	name: string;
	note: string;
	stage: KanbanStage;
	revision: number;
	updatedAt: number;
	deletedAt: number | null;
	sourceClientId: string | null;
}

export interface LocalItem extends ServerItem {
	syncStatus: SyncStatus;
	lastError: string | null;
}

export interface ClientSyncItem {
	id: string;
	name: string;
	note: string;
	stage: KanbanStage;
	updatedAt: number;
	deletedAt: number | null;
}

export interface OutboxMutation {
	id: string;
	transactionId: string;
	sequence: number;
	itemId: string;
	op: MutationOperation;
	item: ClientSyncItem;
	createdAt: number;
	attempts: number;
	lastError: string | null;
}

export interface MetaRecord {
	key: string;
	value: string;
}

export interface SyncChange {
	mutationId: string;
	op: MutationOperation;
	item: ClientSyncItem;
}

export interface SyncTransaction {
	id: string;
	createdAt: number;
	changes: ReadonlyArray<SyncChange>;
}

export interface SyncRequest {
	clientId: string;
	transactions: ReadonlyArray<SyncTransaction>;
}

export interface LegacySyncRequest {
	clientId: string;
	changes: ReadonlyArray<SyncChange>;
}

export interface SyncOutcome {
	transactionId: string;
	mutationId: string;
	itemId: string;
	status: 'applied' | 'conflict' | 'duplicate';
	revision: number;
}

export interface SyncTransactionOutcome {
	transactionId: string;
	status: 'applied' | 'conflict' | 'duplicate';
	mutationIds: string[];
	itemIds: string[];
}

export interface SyncResponse {
	serverTime: number;
	databaseMode: DatabaseMode;
	transactions: SyncTransactionOutcome[];
	applied: SyncOutcome[];
	items: ServerItem[];
}

export interface SyncActivity {
	status: 'idle' | 'syncing' | 'synced' | 'offline' | 'error';
	lastSyncedAt: number | null;
	lastMessage: string;
	error: string | null;
	databaseMode: DatabaseMode | 'unknown';
}

export interface RealtimeActivity {
	status: 'connecting' | 'connected' | 'disconnected' | 'error';
	lastConnectedAt: number | null;
	lastMessageAt: number | null;
	message: string;
}
