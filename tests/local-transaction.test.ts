import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalFirstDatabase } from '../src/lib/client/local-db.ts';
import { runLocalTransaction } from '../src/lib/client/local-transaction.ts';

function idFactory(prefix: string) {
	let sequence = 0;
	return () => `${prefix}-${sequence++}`;
}

function createDatabase(label: string) {
	return new LocalFirstDatabase(`self-sync-test-${label}-${crypto.randomUUID()}`);
}

test('commits local records and grouped outbox mutations atomically', async (t) => {
	const db = createDatabase('commit');
	t.after(() => db.delete());

	const result = await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('commit'), now: () => 100 },
		async (tx) => {
			await tx.insert({ id: 'a', name: 'A', note: '' });
			await tx.insert({ id: 'b', name: 'B', note: '', stage: 'doing' });
			return 'done';
		}
	);
	const items = await db.items.orderBy('id').toArray();
	const outbox = (await db.outbox.toArray()).sort((a, b) => a.sequence - b.sequence);

	assert.equal(result.transactionId, 'commit-0');
	assert.equal(result.value, 'done');
	assert.equal(result.changeCount, 2);
	assert.deepEqual(
		items.map((item) => [item.id, item.syncStatus]),
		[
			['a', 'pending'],
			['b', 'pending']
		]
	);
	assert.deepEqual(
		outbox.map((mutation) => [mutation.transactionId, mutation.sequence, mutation.itemId]),
		[
			['commit-0', 0, 'a'],
			['commit-0', 1, 'b']
		]
	);
});

test('rolls back records and outbox entries when the callback throws', async (t) => {
	const db = createDatabase('rollback');
	t.after(() => db.delete());

	await assert.rejects(
		runLocalTransaction(
			{ db, clientId: 'client-a', createId: idFactory('rollback'), now: () => 100 },
			async (tx) => {
				await tx.insert({ id: 'a', name: 'A', note: '' });
				await tx.insert({ id: 'b', name: 'B', note: '' });
				throw new Error('abort');
			}
		),
		/abort/
	);

	assert.equal(await db.items.count(), 0);
	assert.equal(await db.outbox.count(), 0);
	assert.equal(await db.meta.count(), 0);
});

test('preserves transaction order when writes share a wall-clock millisecond', async (t) => {
	const db = createDatabase('clock');
	t.after(() => db.delete());

	await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('first'), now: () => 100 },
		(tx) => tx.insert({ id: 'a', name: 'A', note: '' })
	);
	await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('second'), now: () => 100 },
		(tx) => tx.insert({ id: 'b', name: 'B', note: '' })
	);

	const outbox = await db.outbox.orderBy('createdAt').toArray();
	assert.deepEqual(
		outbox.map((mutation) => [mutation.transactionId, mutation.createdAt]),
		[
			['first-0', 100],
			['second-0', 101]
		]
	);
});

test('compacts single-item edits without splitting multi-item transactions', async (t) => {
	const db = createDatabase('compact');
	t.after(() => db.delete());

	await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('one'), now: () => 100 },
		(tx) => tx.insert({ id: 'a', name: 'A', note: '' })
	);
	await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('two'), now: () => 200 },
		(tx) => tx.patch('a', { name: 'A2' })
	);

	assert.deepEqual(
		(await db.outbox.toArray()).map((mutation) => mutation.transactionId),
		['two-0']
	);

	await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('multi'), now: () => 300 },
		async (tx) => {
			await tx.patch('a', { stage: 'doing' });
			await tx.insert({ id: 'b', name: 'B', note: '' });
		}
	);
	await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('latest'), now: () => 400 },
		(tx) => tx.patch('a', { name: 'A3' })
	);

	const transactionSizes = new Map<string, number>();
	for (const mutation of await db.outbox.toArray()) {
		transactionSizes.set(
			mutation.transactionId,
			(transactionSizes.get(mutation.transactionId) ?? 0) + 1
		);
	}

	assert.deepEqual([...transactionSizes.entries()].sort(), [
		['latest-0', 1],
		['multi-0', 2]
	]);
});

test('an insert deleted in the same callback leaves no local trace', async (t) => {
	const db = createDatabase('cancel');
	t.after(() => db.delete());

	const result = await runLocalTransaction(
		{ db, clientId: 'client-a', createId: idFactory('cancel'), now: () => 100 },
		async (tx) => {
			await tx.insert({ id: 'a', name: 'A', note: '' });
			await tx.delete('a');
		}
	);

	assert.equal(result.changeCount, 0);
	assert.equal(await db.items.count(), 0);
	assert.equal(await db.outbox.count(), 0);
});
