import { env } from '$env/dynamic/private';
import { json, type RequestHandler } from '@sveltejs/kit';
import { Effect } from 'effect';
import { publishSyncChange } from '$lib/server/realtime';
import { syncProgram } from '$lib/server/sync-service';

function errorResponse(error: unknown) {
	const tag = typeof error === 'object' && error && '_tag' in error ? String(error._tag) : '';
	const message = error instanceof Error ? error.message : 'Sync failed';
	const status = tag.includes('Parse') || tag.includes('InvalidSyncRequest') ? 400 : 500;

	return json({ error: message, tag }, { status });
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const result = await Effect.runPromise(syncProgram(body));

		const changedItemIds = [
			...new Set(
				result.applied
					.filter((outcome) => outcome.status !== 'conflict')
					.map((outcome) => outcome.itemId)
			)
		];

		if (
			changedItemIds.length > 0 &&
			typeof body === 'object' &&
			body !== null &&
			'clientId' in body &&
			typeof body.clientId === 'string'
		) {
			await publishSyncChange({
				sourceClientId: body.clientId,
				itemIds: changedItemIds,
				databaseMode: result.databaseMode,
				serverTime: result.serverTime
			}, {
				publishDatabaseUrl: env.DATABASE_URL
			});
		}

		return json(result);
	} catch (error) {
		return errorResponse(error);
	}
};
