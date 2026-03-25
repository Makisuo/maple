ALTER TABLE `alert_delivery_events` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `alert_delivery_events` ADD `claim_expires_at` integer;--> statement-breakpoint
ALTER TABLE `alert_delivery_events` ADD `claimed_by` text;--> statement-breakpoint
CREATE INDEX `alert_delivery_events_claim_idx` ON `alert_delivery_events` (`status`,`claim_expires_at`,`scheduled_at`);
