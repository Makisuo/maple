-- Add groupBy column to alert_rules
ALTER TABLE `alert_rules` ADD COLUMN `group_by` text;
--> statement-breakpoint

-- Recreate alert_rule_states with group_key in the primary key
-- SQLite cannot alter primary keys, so we must recreate the table
CREATE TABLE `alert_rule_states_new` (
  `org_id` text NOT NULL,
  `rule_id` text NOT NULL,
  `group_key` text NOT NULL DEFAULT '__total__',
  `consecutive_breaches` integer NOT NULL DEFAULT 0,
  `consecutive_healthy` integer NOT NULL DEFAULT 0,
  `last_status` text,
  `last_value` real,
  `last_sample_count` integer,
  `last_evaluated_at` integer,
  `last_error` text,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`org_id`, `rule_id`, `group_key`)
);
--> statement-breakpoint

INSERT INTO `alert_rule_states_new` (
  `org_id`, `rule_id`, `group_key`,
  `consecutive_breaches`, `consecutive_healthy`,
  `last_status`, `last_value`, `last_sample_count`,
  `last_evaluated_at`, `last_error`, `updated_at`
)
SELECT
  `org_id`, `rule_id`, '__total__',
  `consecutive_breaches`, `consecutive_healthy`,
  `last_status`, `last_value`, `last_sample_count`,
  `last_evaluated_at`, `last_error`, `updated_at`
FROM `alert_rule_states`;
--> statement-breakpoint

DROP TABLE `alert_rule_states`;
--> statement-breakpoint

ALTER TABLE `alert_rule_states_new` RENAME TO `alert_rule_states`;
--> statement-breakpoint

CREATE INDEX `alert_rule_states_org_idx` ON `alert_rule_states` (`org_id`);
