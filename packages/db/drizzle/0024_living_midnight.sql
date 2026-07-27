ALTER TABLE "slack_workspaces" ALTER COLUMN "bot_token_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_workspaces" ALTER COLUMN "bot_token_iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_workspaces" ALTER COLUMN "bot_token_tag" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_workspaces" ALTER COLUMN "api_key_secret_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_workspaces" ALTER COLUMN "api_key_secret_iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_workspaces" ALTER COLUMN "api_key_secret_tag" DROP NOT NULL;