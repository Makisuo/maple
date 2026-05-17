CREATE TABLE `org_onboarding_state` (
	`org_id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`email` text,
	`role` text,
	`demo_data_requested` integer DEFAULT 0 NOT NULL,
	`onboarding_completed_at` integer,
	`checklist_dismissed_at` integer,
	`first_data_received_at` integer,
	`welcome_email_sent_at` integer,
	`connect_nudge_email_sent_at` integer,
	`stalled_email_sent_at` integer,
	`activation_email_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
