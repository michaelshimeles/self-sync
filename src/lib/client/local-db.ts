import Dexie, { type Table } from 'dexie';
import type { LocalItem, MetaRecord, OutboxMutation } from '$lib/shared/types';

class LocalFirstDatabase extends Dexie {
	items!: Table<LocalItem, string>;
	outbox!: Table<OutboxMutation, string>;
	meta!: Table<MetaRecord, string>;

	constructor() {
		super('sveltekit-effect-local-first');

		this.version(1).stores({
			items: 'id, syncStatus, updatedAt, deletedAt, revision',
			outbox: 'id, itemId, op, createdAt, attempts',
			meta: 'key'
		});
	}
}

export const db = new LocalFirstDatabase();
