CREATE TABLE "error_issue_pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_repo_id" text,
	"repo_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"author_login" text,
	"state" text DEFAULT 'open' NOT NULL,
	"merged_at" timestamp with time zone,
	"merge_commit_sha" text,
	"link_source" text NOT NULL,
	"linked_by_actor_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_issue_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"pull_request_id" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"verify_after" timestamp with time zone NOT NULL,
	"baseline_versions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baseline_occurrence_count" integer DEFAULT 0 NOT NULL,
	"baseline_rate_per_hour" double precision DEFAULT 0 NOT NULL,
	"investigation_id" text,
	"verdict" text,
	"verdict_note" text,
	"post_merge_occurrence_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "error_issue_pull_requests_issue_pr_idx" ON "error_issue_pull_requests" USING btree ("org_id","issue_id","provider","repo_full_name","number");--> statement-breakpoint
CREATE INDEX "error_issue_pull_requests_repo_number_idx" ON "error_issue_pull_requests" USING btree ("org_id","provider","repo_full_name","number");--> statement-breakpoint
CREATE INDEX "error_issue_pull_requests_issue_idx" ON "error_issue_pull_requests" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE INDEX "error_issue_verifications_due_idx" ON "error_issue_verifications" USING btree ("status","verify_after");--> statement-breakpoint
CREATE INDEX "error_issue_verifications_issue_idx" ON "error_issue_verifications" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "error_issue_verifications_open_idx" ON "error_issue_verifications" USING btree ("org_id","issue_id") WHERE "error_issue_verifications"."status" in ('waiting', 'running');