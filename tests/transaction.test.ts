import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncTransaction } from '../src/lib/shared/types.ts';
import {
	InvalidSyncTransactionError,
	planSyncTransaction,
	type StoredSyncItem
} from '../src/lib/server/transaction.ts';

function transaction(
	id: string,
	changes: Array<{
		mutationId: string;
		itemId: string;
		updatedAt: number;
		name?: string;
	}>
): SyncTransaction {
	return {
		id,
		createdAt: 100,
		changes: changes.map((change) => ({
			mutationId: change.mutationId,
			op: 'upsert',
			item: {
				id: change.itemId,
				name: change.name ?? change.itemId,
				note: '',
				stage: 'todo',
				updatedAt: change.updatedAt,
				deletedAt: null
			}
		}))
	};
}

function stored(input: Partial<StoredSyncItem> & Pick<StoredSyncItem, 'id'>): StoredSyncItem {
	return {
		id: input.id,
		name: input.name ?? input.id,
		note: input.note ?? '',
		stage: input.stage ?? 'todo',
		revision: input.revision ?? 1,
		updatedAt: input.updatedAt ?? 100,
		deletedAt: input.deletedAt ?? null,
		sourceClientId: input.sourceClientId ?? 'server-client',
		lastMutationId: input.lastMutationId ?? 'server-mutation'
	};
}

test('plans every write in a multi-item transaction together', () => {
	const plan = planSyncTransaction({
		clientId: 'client-a',
		transaction: transaction('tx-1', [
			{ mutationId: 'm-1', itemId: 'a', updatedAt: 101 },
			{ mutationId: 'm-2', itemId: 'b', updatedAt: 102 }
		]),
		currentItems: new Map([['a', stored({ id: 'a', revision: 4, updatedAt: 100 })]])
	});

	assert.equal(plan.status, 'applied');
	assert.equal(plan.recordStatus, 'applied');
	assert.deepEqual(
		plan.writes.map((item) => [item.id, item.revision]),
		[
			['a', 5],
			['b', 1]
		]
	);
	assert.ok(plan.outcomes.every((outcome) => outcome.status === 'applied'));
});

test('rejects the whole transaction when one write conflicts', () => {
	const plan = planSyncTransaction({
		clientId: 'client-a',
		transaction: transaction('tx-2', [
			{ mutationId: 'm-1', itemId: 'a', updatedAt: 90 },
			{ mutationId: 'm-2', itemId: 'new-item', updatedAt: 110 }
		]),
		currentItems: new Map([['a', stored({ id: 'a', revision: 3, updatedAt: 100 })]])
	});

	assert.equal(plan.status, 'conflict');
	assert.equal(plan.recordStatus, 'conflict');
	assert.deepEqual(plan.writes, []);
	assert.ok(plan.outcomes.every((outcome) => outcome.status === 'conflict'));
});

test('returns a duplicate without writes for an already committed transaction', () => {
	const plan = planSyncTransaction({
		clientId: 'client-a',
		transaction: transaction('tx-3', [
			{ mutationId: 'm-1', itemId: 'a', updatedAt: 101 },
			{ mutationId: 'm-2', itemId: 'b', updatedAt: 102 }
		]),
		currentItems: new Map(),
		terminalStatus: 'applied'
	});

	assert.equal(plan.status, 'duplicate');
	assert.equal(plan.recordStatus, null);
	assert.deepEqual(plan.writes, []);
});

test('uses a deterministic client and mutation tie-breaker', () => {
	const current = stored({
		id: 'a',
		updatedAt: 100,
		sourceClientId: 'client-z',
		lastMutationId: 'm-z'
	});
	const losingPlan = planSyncTransaction({
		clientId: 'client-a',
		transaction: transaction('tx-4', [{ mutationId: 'm-a', itemId: 'a', updatedAt: 100 }]),
		currentItems: new Map([['a', current]])
	});
	const winningPlan = planSyncTransaction({
		clientId: 'client-zz',
		transaction: transaction('tx-5', [{ mutationId: 'm-a', itemId: 'a', updatedAt: 100 }]),
		currentItems: new Map([['a', current]])
	});

	assert.equal(losingPlan.status, 'conflict');
	assert.equal(winningPlan.status, 'applied');
});

test('rejects repeated item writes inside one transaction', () => {
	assert.throws(
		() =>
			planSyncTransaction({
				clientId: 'client-a',
				transaction: transaction('tx-6', [
					{ mutationId: 'm-1', itemId: 'a', updatedAt: 100 },
					{ mutationId: 'm-2', itemId: 'a', updatedAt: 101 }
				]),
				currentItems: new Map()
			}),
		InvalidSyncTransactionError
	);
});
