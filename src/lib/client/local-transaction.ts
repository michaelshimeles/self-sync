import type { LocalFirstDatabase } from './local-db';
import type {
	ClientSyncItem,
	KanbanStage,
	LocalItem,
	MutationOperation,
	OutboxMutation
} from '$lib/shared/types';

export type ItemPatch = Partial<Pick<LocalItem, 'name' | 'note' | 'stage'>>;

export interface LocalTransactionContext {
	readonly id: string;
	get(id: string): Promise<LocalItem | undefined>;
	list(options?: { includeDeleted?: boolean }): Promise<LocalItem[]>;
	insert(input: {
		id?: string;
		name: string;
		note: string;
		stage?: KanbanStage;
	}): Promise<LocalItem>;
	patch(id: string, patch: ItemPatch): Promise<LocalItem | undefined>;
	delete(id: string): Promise<LocalItem | undefined>;
}

export interface LocalTransactionResult<T> {
	transactionId: string;
	value: T;
	changeCount: number;
}

interface StagedChange {
	item: LocalItem;
	op: MutationOperation;
	sequence: number;
}

interface LocalTransactionOptions {
	db: LocalFirstDatabase;
	clientId: string;
	createId?: () => string;
	now?: () => number;
}

function toSyncItem(item: LocalItem): ClientSyncItem {
	return {
		id: item.id,
		name: item.name,
		note: item.note,
		stage: item.stage ?? 'todo',
		updatedAt: item.updatedAt,
		deletedAt: item.deletedAt
	};
}

function createMutation(input: {
	createId: () => string;
	transactionId: string;
	sequence: number;
	createdAt: number;
	op: MutationOperation;
	item: LocalItem;
}): OutboxMutation {
	return {
		id: input.createId(),
		transactionId: input.transactionId,
		sequence: input.sequence,
		itemId: input.item.id,
		op: input.op,
		item: toSyncItem(input.item),
		createdAt: input.createdAt,
		attempts: 0,
		lastError: null
	};
}

async function compactSingleItemTransactions(db: LocalFirstDatabase, itemId: string) {
	const pending = await db.outbox.where('itemId').equals(itemId).toArray();

	for (const mutation of pending) {
		const transactionSize = await db.outbox
			.where('transactionId')
			.equals(mutation.transactionId)
			.count();
		if (transactionSize === 1) await db.outbox.delete(mutation.id);
	}
}

export async function runLocalTransaction<T>(
	options: LocalTransactionOptions,
	handler: (transaction: LocalTransactionContext) => T | Promise<T>
): Promise<LocalTransactionResult<T>> {
	const createId = options.createId ?? (() => crypto.randomUUID());
	const now = options.now ?? Date.now;
	const transactionId = createId();

	return options.db.transaction(
		'rw',
		options.db.items,
		options.db.outbox,
		options.db.meta,
		async () => {
			const previousClock = Number((await options.db.meta.get('transaction-clock'))?.value ?? 0);
			const createdAt = Math.max(now(), previousClock + 1);
			await options.db.meta.put({ key: 'transaction-clock', value: String(createdAt) });
			const originals = new Map<string, LocalItem | undefined>();
			const staged = new Map<string, StagedChange>();
			let nextSequence = 0;
			let logicalTime = createdAt - 1;

			const read = async (id: string) => {
				const pending = staged.get(id);
				if (pending) return pending.item;
				if (originals.has(id)) return originals.get(id);

				const item = await options.db.items.get(id);
				originals.set(id, item);
				return item;
			};

			const timestamp = (item?: LocalItem) => {
				logicalTime = Math.max(now(), logicalTime + 1, (item?.updatedAt ?? 0) + 1);
				return logicalTime;
			};

			const stage = (item: LocalItem, op: MutationOperation) => {
				const existing = staged.get(item.id);
				staged.set(item.id, {
					item,
					op,
					sequence: existing?.sequence ?? nextSequence++
				});
			};

			const transaction: LocalTransactionContext = {
				id: transactionId,
				get: read,
				list: async (listOptions = {}) => {
					const rows = new Map((await options.db.items.toArray()).map((item) => [item.id, item]));
					for (const change of staged.values()) rows.set(change.item.id, change.item);

					return [...rows.values()]
						.filter((item) => listOptions.includeDeleted || item.deletedAt === null)
						.sort((a, b) => b.updatedAt - a.updatedAt);
				},
				insert: async (input) => {
					const name = input.name.trim();
					if (!name) throw new Error('A local item needs a name');

					const id = input.id ?? createId();
					if (await read(id)) throw new Error(`Local item ${id} already exists`);

					const item: LocalItem = {
						id,
						name,
						note: input.note.trim(),
						stage: input.stage ?? 'todo',
						revision: 0,
						updatedAt: timestamp(),
						deletedAt: null,
						sourceClientId: options.clientId,
						syncStatus: 'pending',
						lastError: null
					};

					stage(item, 'upsert');
					return item;
				},
				patch: async (id, patch) => {
					const existing = await read(id);
					if (!existing || existing.deletedAt !== null) return undefined;

					const item: LocalItem = {
						...existing,
						...patch,
						name: patch.name ?? existing.name,
						note: patch.note ?? existing.note,
						stage: patch.stage ?? existing.stage ?? 'todo',
						updatedAt: timestamp(existing),
						sourceClientId: options.clientId,
						syncStatus: 'pending',
						lastError: null
					};

					stage(item, 'upsert');
					return item;
				},
				delete: async (id) => {
					const existing = await read(id);
					if (!existing) return undefined;

					if (originals.get(id) === undefined && staged.has(id)) {
						staged.delete(id);
						return undefined;
					}

					const deletedAt = timestamp(existing);
					const item: LocalItem = {
						...existing,
						updatedAt: deletedAt,
						deletedAt,
						sourceClientId: options.clientId,
						syncStatus: 'pending',
						lastError: null
					};

					stage(item, 'delete');
					return item;
				}
			};

			const value = await handler(transaction);
			const changes = [...staged.values()].sort((a, b) => a.sequence - b.sequence);

			if (changes.length === 1) {
				await compactSingleItemTransactions(options.db, changes[0].item.id);
			}

			if (changes.length > 0) {
				await options.db.items.bulkPut(changes.map((change) => change.item));
				await options.db.outbox.bulkAdd(
					changes.map((change) =>
						createMutation({
							createId,
							transactionId,
							sequence: change.sequence,
							createdAt,
							op: change.op,
							item: change.item
						})
					)
				);
			}

			return { transactionId, value, changeCount: changes.length };
		}
	);
}
