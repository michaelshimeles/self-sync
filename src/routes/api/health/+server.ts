import { json, type RequestHandler } from '@sveltejs/kit';
import { Effect } from 'effect';
import { healthProgram } from '$lib/server/sync-service';

export const GET: RequestHandler = async () => {
	try {
		const result = await Effect.runPromise(healthProgram());
		return json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Health check failed';
		return json({ ok: false, error: message }, { status: 500 });
	}
};
