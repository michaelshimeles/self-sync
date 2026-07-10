import type {
	KanbanStage,
	ServerItem,
	SyncOutcome,
	SyncTransaction,
	SyncTransactionOutcome
} from '$lib/shared/types';

export type TerminalTransactionStatus = 'applied' | 'conflict';

export interface StoredSyncItem extends ServerItem {
	lastMutationId: string | null;
}

export interface TransactionPlan {
	status: SyncTransactionOutcome['status'];
	writes: StoredSyncItem[];
	outcomes: SyncOutcome[];
	transaction: SyncTransactionOutcome;
	recordStatus: TerminalTransactionStatus | null;
}

export class InvalidSyncTransactionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidSyncTransactionError';
	}
}

export function normaliseStage(value: unknown): KanbanStage {
	if (value === 'doing' || value === 'done') return value;
	return 'todo';
}

export function toServerItem(item: StoredSyncItem): ServerItem {
	return {
		id: item.id,
		name: item.name,
		note: item.note,
		stage: normaliseStage(item.stage),
		revision: item.revision,
		updatedAt: item.updatedAt,
		deletedAt: item.deletedAt,
		sourceClientId: item.sourceClientId
	};
}

export function sortItems(items: ServerItem[]) {
	return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function validateSyncTransaction(transaction: SyncTransaction) {
	if (!transaction.id || transaction.id.length > 128) {
		throw new InvalidSyncTransactionError('Transaction IDs must be between 1 and 128 characters');
	}

	if (transaction.changes.length === 0) {
		throw new InvalidSyncTransactionError(`Transaction ${transaction.id} has no changes`);
	}

	const itemIds = new Set<string>();
	const mutationIds = new Set<string>();

	for (const change of transaction.changes) {
		if (!change.mutationId || change.mutationId.length > 128) {
			throw new InvalidSyncTransactionError('Mutation IDs must be between 1 and 128 characters');
		}

		if (!change.item.id || change.item.id.length > 64) {
			throw new InvalidSyncTransactionError('Item IDs must be between 1 and 64 characters');
		}

		if (itemIds.has(change.item.id)) {
			throw new InvalidSyncTransactionError(
				`Transaction ${transaction.id} changes item ${change.item.id} more than once`
			);
		}

		if (mutationIds.has(change.mutationId)) {
			throw new InvalidSyncTransactionError(
				`Transaction ${transaction.id} repeats mutation ${change.mutationId}`
			);
		}

		itemIds.add(change.item.id);
		mutationIds.add(change.mutationId);
	}
}

function normaliseIncoming(
	transaction: SyncTransaction,
	change: SyncTransaction['changes'][number]
): ServerItem {
	const fallbackTime = transaction.createdAt || 1;

	return {
		id: change.item.id,
		name: change.item.name.trim() || 'Untitled',
		note: change.item.note,
		stage: normaliseStage(change.item.stage),
		revision: 0,
		updatedAt: change.item.updatedAt || fallbackTime,
		deletedAt:
			change.op === 'delete' ? (change.item.deletedAt ?? fallbackTime) : change.item.deletedAt,
		sourceClientId: null
	};
}

function incomingWins(
	current: StoredSyncItem,
	incoming: ServerItem,
	clientId: string,
	mutationId: string
) {
	if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt;

	const incomingKey = `${clientId}:${mutationId}`;
	const currentKey = `${current.sourceClientId ?? ''}:${current.lastMutationId ?? ''}`;
	return incomingKey > currentKey;
}

function buildResult(
	transaction: SyncTransaction,
	status: SyncTransactionOutcome['status'],
	currentItems: ReadonlyMap<string, StoredSyncItem>,
	writes: StoredSyncItem[],
	recordStatus: TerminalTransactionStatus | null
): TransactionPlan {
	const revisions = new Map(writes.map((item) => [item.id, item.revision]));
	const outcomes = transaction.changes.map(
		(change): SyncOutcome => ({
			transactionId: transaction.id,
			mutationId: change.mutationId,
			itemId: change.item.id,
			status,
			revision: revisions.get(change.item.id) ?? currentItems.get(change.item.id)?.revision ?? 0
		})
	);

	return {
		status,
		writes,
		outcomes,
		transaction: {
			transactionId: transaction.id,
			status,
			mutationIds: outcomes.map((outcome) => outcome.mutationId),
			itemIds: outcomes.map((outcome) => outcome.itemId)
		},
		recordStatus
	};
}

export function planSyncTransaction(input: {
	clientId: string;
	transaction: SyncTransaction;
	currentItems: ReadonlyMap<string, StoredSyncItem>;
	terminalStatus?: TerminalTransactionStatus | null;
}): TransactionPlan {
	const { clientId, transaction, currentItems, terminalStatus = null } = input;
	validateSyncTransaction(transaction);

	if (terminalStatus) {
		return buildResult(
			transaction,
			terminalStatus === 'applied' ? 'duplicate' : 'conflict',
			currentItems,
			[],
			null
		);
	}

	const wasAlreadyApplied = transaction.changes.every((change) => {
		const current = currentItems.get(change.item.id);
		return (
			current?.sourceClientId === clientId && current.lastMutationId === change.mutationId
		);
	});

	if (wasAlreadyApplied) {
		return buildResult(transaction, 'duplicate', currentItems, [], 'applied');
	}

	const incoming = transaction.changes.map((change) => ({
		change,
		item: normaliseIncoming(transaction, change)
	}));
	const hasConflict = incoming.some(({ change, item }) => {
		const current = currentItems.get(item.id);
		return current ? !incomingWins(current, item, clientId, change.mutationId) : false;
	});

	if (hasConflict) {
		return buildResult(transaction, 'conflict', currentItems, [], 'conflict');
	}

	const writes = incoming.map(({ change, item }): StoredSyncItem => {
		const current = currentItems.get(item.id);
		return {
			...item,
			revision: (current?.revision ?? 0) + 1,
			sourceClientId: clientId,
			lastMutationId: change.mutationId
		};
	});

	return buildResult(transaction, 'applied', currentItems, writes, 'applied');
}
