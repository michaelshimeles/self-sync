import { json, type RequestHandler } from '@sveltejs/kit';
import { Effect } from 'effect';
import { syncProgram } from '$lib/server/sync-service';

function errorResponse(error: unknown) {
	const tag = typeof error === 'object' && error && '_tag' in error ? String(error._tag) : '';
	const message = error instanceof Error ? error.message : 'Sync failed';
	const status = tag.includes('Parse') ? 400 : 500;

	return json({ error: message, tag }, { status });
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const result = await Effect.runPromise(syncProgram(body));
		return json(result);
	} catch (error) {
		return errorResponse(error);
	}
};
