import { IsoDateTimeString, ScrapeTargetCheckResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { createSyncedCollection, timestamptzParser } from "./shape-fetch"

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

// ---------------------------------------------------------------------------
// scrape_target_checks
// ---------------------------------------------------------------------------

/**
 * Identity row schema for the `scrape_target_checks` shape — one row per
 * scheduled scrape attempt (uptime-probe history). The table is already pruned
 * server-side to a 24h window + a 10k-per-target cap (ScrapeTargetsService.
 * pruneChecks), so the whole per-org shape stays bounded. `id` is an int4
 * identity (Electric's default parser decodes int4 → number). No secrets.
 */
export const ScrapeTargetCheckRowSchema = Schema.Struct({
	id: Schema.Number,
	target_id: Schema.String,
	org_id: Schema.String,
	sub_target_key: Schema.String,
	checked_at: Schema.String,
	error: Schema.NullOr(Schema.String),
	duration_ms: Schema.NullOr(Schema.Number),
	samples_scraped: Schema.NullOr(Schema.Number),
	samples_post_relabel: Schema.NullOr(Schema.Number),
})
export type ScrapeTargetCheckRow = typeof ScrapeTargetCheckRowSchema.Type

/**
 * Decodes a raw `scrape_target_checks` row into the domain
 * {@link ScrapeTargetCheckResponse}, mirroring the transform in the server's
 * `listChecks` route handler (scrape-targets.http.ts): `error === null` →
 * `success`, empty `sub_target_key` → null, `duration_ms / 1000` → seconds,
 * `samples_post_relabel` → `samplesPostMetricRelabeling`.
 */
export const rowToScrapeTargetCheckDocument = (row: ScrapeTargetCheckRow): ScrapeTargetCheckResponse =>
	new ScrapeTargetCheckResponse({
		timestamp: decodeIso(row.checked_at),
		success: row.error === null,
		subTargetKey: row.sub_target_key === "" ? null : row.sub_target_key,
		durationSeconds: row.duration_ms === null ? null : row.duration_ms / 1000,
		samplesScraped: row.samples_scraped,
		samplesPostMetricRelabeling: row.samples_post_relabel,
		message: row.error,
	})

export const createScrapeTargetChecksCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "scrape_target_checks",
		orgId,
		schema: ScrapeTargetCheckRowSchema,
		parser: timestamptzParser,
		getKey: (row) => String(row.id),
	})

export type ScrapeTargetChecksCollection = ReturnType<typeof createScrapeTargetChecksCollection>
