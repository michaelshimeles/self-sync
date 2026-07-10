import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5174';
const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const clientId = `transaction-verifier-${runId}`;
const itemA = `tx-a-${runId}`;
const itemB = `tx-b-${runId}`;
const itemC = `tx-c-${runId}`;
const legacyItem = `tx-legacy-${runId}`;
const timestamp = Date.now();

function change(mutationId, id, name, updatedAt) {
	return {
		mutationId,
		op: 'upsert',
		item: {
			id,
			name,
			note: 'Transaction verification',
			stage: 'todo',
			updatedAt,
			deletedAt: null
		}
	};
}

async function postSync(transactions) {
	const response = await fetch(`${baseUrl}/api/sync`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ clientId, transactions })
	});
	const body = await response.json();

	assert.equal(response.status, 200, JSON.stringify(body));
	return body;
}

async function postLegacySync(changes) {
	const response = await fetch(`${baseUrl}/api/sync`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ clientId, changes })
	});
	const body = await response.json();

	assert.equal(response.status, 200, JSON.stringify(body));
	return body;
}

const healthResponse = await fetch(`${baseUrl}/api/health`);
const health = await healthResponse.json();
assert.equal(healthResponse.status, 200, JSON.stringify(health));
assert.equal(
	health.databaseMode,
	'memory',
	'This verifier intentionally refuses to write test transactions to a persistent database'
);

const atomicTransaction = {
	id: `atomic-${runId}`,
	createdAt: timestamp,
	changes: [
		change(`atomic-a-${runId}`, itemA, 'Atomic A', timestamp),
		change(`atomic-b-${runId}`, itemB, 'Atomic B', timestamp + 1)
	]
};
const applied = await postSync([atomicTransaction]);
assert.equal(applied.transactions[0]?.status, 'applied');
assert.ok(applied.applied.every((outcome) => outcome.status === 'applied'));
assert.ok(applied.items.some((item) => item.id === itemA));
assert.ok(applied.items.some((item) => item.id === itemB));

const duplicate = await postSync([atomicTransaction]);
assert.equal(duplicate.transactions[0]?.status, 'duplicate');
assert.ok(duplicate.applied.every((outcome) => outcome.status === 'duplicate'));

const conflictingTransaction = {
	id: `conflict-${runId}`,
	createdAt: timestamp + 2,
	changes: [
		change(`conflict-a-${runId}`, itemA, 'Stale A', timestamp - 1),
		change(`conflict-c-${runId}`, itemC, 'Must not commit', timestamp + 2)
	]
};
const conflicted = await postSync([conflictingTransaction]);
assert.equal(conflicted.transactions[0]?.status, 'conflict');
assert.ok(conflicted.applied.every((outcome) => outcome.status === 'conflict'));
assert.ok(!conflicted.items.some((item) => item.id === itemC));

const legacy = await postLegacySync([
	change(`legacy-${runId}`, legacyItem, 'Legacy client compatibility', timestamp + 3)
]);
assert.equal(legacy.transactions[0]?.status, 'applied');
assert.equal(legacy.transactions[0]?.transactionId, `legacy:legacy-${runId}`);

console.log(
	JSON.stringify(
		{
			ok: true,
			databaseMode: health.databaseMode,
			applied: applied.transactions[0].status,
			retry: duplicate.transactions[0].status,
			conflict: conflicted.transactions[0].status,
			partialWritePrevented: !conflicted.items.some((item) => item.id === itemC),
			legacyClient: legacy.transactions[0].status
		},
		null,
		2
	)
);
