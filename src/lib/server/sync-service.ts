import { Context, Data, Effect, Schema } from 'effect';
import { SyncRequestSchema } from '$lib/shared/schema';
import { getStorage, type SyncStorage } from './storage';

export class StorageFailure extends Data.TaggedError('StorageFailure')<{
	message: string;
	cause: unknown;
}> {}

class StorageContext extends Context.Tag('StorageContext')<StorageContext, SyncStorage>() {}

function provideStorage<A, E, R>(effect: Effect.Effect<A, E, R>) {
	return Effect.provideService(effect, StorageContext, getStorage());
}

export function syncProgram(input: unknown) {
	return provideStorage(
		Effect.gen(function* () {
			const request = yield* Schema.decodeUnknown(SyncRequestSchema)(input);
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
