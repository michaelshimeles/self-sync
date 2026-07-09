create table if not exists sync_items (
	id text primary key,
	name text not null,
	note text not null default '',
	revision integer not null default 0,
	updated_at bigint not null,
	deleted_at bigint,
	source_client_id text,
	last_mutation_id text
);

create index if not exists sync_items_updated_at_idx on sync_items (updated_at desc);
