import { json, type RequestHandler } from '@sveltejs/kit';
import { Effect } from 'effect';
import { listItemsProgram } from '$lib/server/sync-service';

export const GET: RequestHandler = async () => {
	try {
		const items = await Effect.runPromise(listItemsProgram());
		return json({ items });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to load items';
		return json({ error: message }, { status: 500 });
	}
};
