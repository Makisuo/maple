ALTER TABLE `alert_rules` ADD `service_names_json` text;--> statement-breakpoint
UPDATE `alert_rules` SET `service_names_json` = CASE WHEN `service_name` IS NOT NULL THEN json_array(`service_name`) ELSE NULL END;
