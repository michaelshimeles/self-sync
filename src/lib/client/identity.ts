import { browser } from '$app/environment';

const CLIENT_ID_KEY = 'self-sync-client-id';

export function getClientId() {
	if (!browser) return 'server';

	const existing = localStorage.getItem(CLIENT_ID_KEY);
	if (existing) return existing;

	const next = crypto.randomUUID();
	localStorage.setItem(CLIENT_ID_KEY, next);
	return next;
}
