ALTER TABLE `api_keys` ADD `kind` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `created_by_email` text;