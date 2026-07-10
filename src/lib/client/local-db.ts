import Dexie, { type Table } from 'dexie';
import type { LocalItem, MetaRecord, OutboxMutation } from '$lib/shared/types';

export class LocalFirstDatabase extends Dexie {
	items!: Table<LocalItem, string>;
	outbox!: Table<OutboxMutation, string>;
	meta!: Table<MetaRecord, string>;

	constructor(name = 'self-sync') {
		super(name);

		this.version(1).stores({
			items: 'id, syncStatus, updatedAt, deletedAt, revision',
			outbox: 'id, itemId, op, createdAt, attempts',
			meta: 'key'
		});

		this.version(2)
			.stores({
				items: 'id, syncStatus, updatedAt, deletedAt, revision, stage',
				outbox: 'id, itemId, op, createdAt, attempts',
				meta: 'key'
			})
			.upgrade((tx) =>
				tx
					.table<LocalItem, string>('items')
					.toCollection()
					.modify((item) => {
						item.stage ??= 'todo';
					})
			);

		this.version(3)
			.stores({
				items: 'id, syncStatus, updatedAt, deletedAt, revision, stage',
				outbox:
					'id, transactionId, [transactionId+sequence], itemId, op, createdAt, attempts',
				meta: 'key'
			})
			.upgrade((tx) =>
				tx
					.table<OutboxMutation, string>('outbox')
					.toCollection()
					.modify((mutation) => {
						mutation.transactionId ??= `legacy:${mutation.id}`;
						mutation.sequence ??= 0;
					})
			);
	}
}

export const db = new LocalFirstDatabase();
