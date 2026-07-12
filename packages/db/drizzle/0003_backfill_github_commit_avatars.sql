-- Backfill author_avatar_url for GitHub commits ingested before the commit-indicator
-- rework moved avatar derivation out of the dashboard and into ingestion.
--
-- Push-webhook commits historically stored a null avatar (the payload carries only a
-- committer username, never an avatar URL), and the dashboard derived a fallback avatar
-- client-side from the login. That client-side fallback has been removed, so these older
-- rows would now render without an avatar. Reconstruct the exact URL the backend now
-- derives at ingest (githubAvatarUrl in apps/api/.../vendor/github/GithubProvider.ts:
-- `new URL('/<login>.png?size=64', html_url)`): the commit's own origin + "/<login>.png?size=64",
-- so github.com and GitHub Enterprise hosts both stay correct without hardcoding a host.
--
-- Scope: only GitHub rows whose avatar is null and whose login is a valid GitHub handle
-- ([A-Za-z0-9-], which needs no URL-encoding). Anything else is left null — an initials
-- fallback — matching the "no derivable avatar" case in the code. Idempotent: once a row
-- has an avatar it is skipped, so re-running is a no-op.
UPDATE "vcs_commits"
SET "author_avatar_url" =
	substring("html_url" from '^https?://[^/]+') || '/' || "author_login" || '.png?size=64'
WHERE "author_avatar_url" IS NULL
	AND "provider" = 'github'
	AND "author_login" IS NOT NULL
	AND "author_login" ~ '^[A-Za-z0-9-]+$'
	AND "html_url" ~ '^https?://[^/]+';
