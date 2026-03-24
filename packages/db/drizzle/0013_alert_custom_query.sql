ALTER TABLE `alert_rules` ADD `query_data_source` text;
--> statement-breakpoint
ALTER TABLE `alert_rules` ADD `query_aggregation` text;
--> statement-breakpoint
ALTER TABLE `alert_rules` ADD `query_where_clause` text;
