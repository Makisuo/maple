CREATE TABLE `org_ingest_sampling_policies` (
	`org_id` text PRIMARY KEY NOT NULL,
	`trace_sample_ratio` real DEFAULT 1 NOT NULL,
	`always_keep_error_spans` integer DEFAULT 1 NOT NULL,
	`always_keep_slow_spans_ms` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
