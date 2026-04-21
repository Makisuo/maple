CREATE TABLE `org_openrouter_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`api_key_ciphertext` text NOT NULL,
	`api_key_iv` text NOT NULL,
	`api_key_tag` text NOT NULL,
	`api_key_last4` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
