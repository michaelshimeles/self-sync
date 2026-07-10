import { Context, Data, Effect, Schema } from 'effect';
import { SyncRequestSchema, type SyncRequestInput } from '$lib/shared/schema';
import type { SyncRequest } from '$lib/shared/types';
import { getStorage, type SyncStorage } from './storage';
import { validateSyncTransaction } from './transaction';

export class StorageFailure extends Data.TaggedError('StorageFailure')<{
	message: string;
	cause: unknown;
}> {}

export class InvalidSyncRequest extends Data.TaggedError('InvalidSyncRequest')<{
	message: string;
	cause: unknown;
}> {}

class StorageContext extends Context.Tag('StorageContext')<StorageContext, SyncStorage>() {}

function provideStorage<A, E, R>(effect: Effect.Effect<A, E, R>) {
	return Effect.provideService(effect, StorageContext, getStorage());
}

function normaliseRequest(decoded: SyncRequestInput): SyncRequest {
	if (!decoded.clientId || decoded.clientId.length > 128) {
		throw new Error('Client IDs must be between 1 and 128 characters');
	}

	const transactions =
		'transactions' in decoded
			? decoded.transactions
			: decoded.changes.map((change) => ({
					id:
						`legacy:${change.mutationId}`.length <= 128
							? `legacy:${change.mutationId}`
							: change.mutationId,
					createdAt: change.item.updatedAt || 1,
					changes: [change]
				}));
	const transactionIds = new Set<string>();

	for (const transaction of transactions) {
		if (transactionIds.has(transaction.id)) {
			throw new Error(`Transaction ${transaction.id} appears more than once`);
		}

		validateSyncTransaction(transaction);
		transactionIds.add(transaction.id);
	}

	return { clientId: decoded.clientId, transactions };
}

export function syncProgram(input: unknown) {
	return provideStorage(
		Effect.gen(function* () {
			const decoded = yield* Schema.decodeUnknown(SyncRequestSchema)(input);
			const request = yield* Effect.try({
				try: () => normaliseRequest(decoded),
				catch: (error) =>
					new InvalidSyncRequest({
						message: error instanceof Error ? error.message : 'Invalid sync request',
						cause: error
					})
			});
			const storage = yield* StorageContext;

			return yield* Effect.tryPromise({
				try: () => storage.applyChanges(request),
				catch: (error) =>
					new StorageFailure({
						message: error instanceof Error ? error.message : 'Storage operation failed',
						cause: error
					})
			});
		})
	);
}

export function listItemsProgram(options: { includeDeleted?: boolean } = {}) {
	return provideStorage(
		Effect.gen(function* () {
			const storage = yield* StorageContext;

			return yield* Effect.tryPromise({
				try: () => storage.listItems(options),
				catch: (error) =>
					new StorageFailure({
						message: error instanceof Error ? error.message : 'Storage operation failed',
						cause: error
					})
			});
		})
	);
}

export function healthProgram() {
	return provideStorage(
		Effect.gen(function* () {
			const storage = yield* StorageContext;
			const items = yield* Effect.tryPromise({
				try: () => storage.listItems({ includeDeleted: true }),
				catch: (error) =>
					new StorageFailure({
						message: error instanceof Error ? error.message : 'Storage operation failed',
						cause: error
					})
			});

			return {
				ok: true,
				databaseMode: storage.mode,
				itemCount: items.length,
				checkedAt: Date.now()
			};
		})
	);
}
