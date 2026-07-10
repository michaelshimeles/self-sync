create table if not exists sync_items (
	id varchar(64) primary key,
	name text not null,
	note text not null,
	stage varchar(16) not null default 'todo',
	revision int not null default 0,
	updated_at bigint not null,
	deleted_at bigint null,
	source_client_id varchar(128) null,
	last_mutation_id varchar(128) null,
	index sync_items_updated_at_idx (updated_at desc)
);

create table if not exists sync_transactions (
	client_id varchar(128) not null,
	id varchar(128) not null,
	status varchar(16) not null,
	committed_at bigint not null,
	primary key (client_id, id)
);
