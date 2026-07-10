import { Schema } from 'effect';

const KanbanStageSchema = Schema.Literal('todo', 'doing', 'done');

export const ClientSyncItemSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	note: Schema.String,
	stage: Schema.optionalWith(KanbanStageSchema, { default: () => 'todo' as const }),
	updatedAt: Schema.Number,
	deletedAt: Schema.NullOr(Schema.Number)
});

export const SyncChangeSchema = Schema.Struct({
	mutationId: Schema.String,
	op: Schema.Literal('upsert', 'delete'),
	item: ClientSyncItemSchema
});

export const SyncTransactionSchema = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	changes: Schema.Array(SyncChangeSchema)
});

export const TransactionSyncRequestSchema = Schema.Struct({
	clientId: Schema.String,
	transactions: Schema.Array(SyncTransactionSchema)
});

export const LegacySyncRequestSchema = Schema.Struct({
	clientId: Schema.String,
	changes: Schema.Array(SyncChangeSchema)
});

export const SyncRequestSchema = Schema.Union(TransactionSyncRequestSchema, LegacySyncRequestSchema);

export type SyncRequestInput = Schema.Schema.Type<typeof SyncRequestSchema>;
