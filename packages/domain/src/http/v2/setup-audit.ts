import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2ServiceUnavailableError } from "./errors"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

export const V2SetupAuditAffectedEntity = Schema.Struct({
	kind: Schema.Literals([
		"service",
		"alert_rule",
		"alert_destination",
		"attribute_mapping",
		"scrape_target",
		"repository",
		"integration",
		"attribute_key",
	]).annotate({
		description: "What kind of object the finding points at.",
		examples: ["alert_rule"],
	}),
	id: Schema.NullOr(Schema.String).annotate({
		description:
			"The object's public ID when it is addressable through this API, otherwise `null`. Treat it as an opaque string.",
		examples: ["alrt_4CzLmR1pTx"],
	}),
	name: Schema.String.annotate({
		description: "Display name of the affected object.",
		examples: ["API error rate"],
	}),
	note: Schema.NullOr(Schema.String).annotate({
		description: "Per-object evidence for the finding.",
		examples: ["every selected destination is disabled or deleted"],
	}),
}).annotate({
	identifier: "SetupAuditAffectedEntity",
	title: "Setup audit affected entity",
	description: "One object a setup audit finding points at.",
})
export type V2SetupAuditAffectedEntity = Schema.Schema.Type<typeof V2SetupAuditAffectedEntity>

export const V2SetupAuditCheck = Schema.Struct({
	object: Schema.Literal("setup_audit_check").annotate({
		description: 'The object type — always `"setup_audit_check"`.',
		examples: ["setup_audit_check"],
	}),
	id: Schema.String.annotate({
		description:
			"Stable check identifier. Safe to key alerting or suppression on — ids are never reused for a different check.",
		examples: ["CFG-ALERT-03"],
	}),
	category: Schema.Literals([
		"alerting",
		"notifications",
		"ingestion",
		"attributes",
		"traces",
		"integrations",
		"data_platform",
	]).annotate({
		description: "Which part of the setup the check covers.",
		examples: ["alerting"],
	}),
	title: Schema.String.annotate({
		description: "What the check asserts, phrased as the healthy state.",
		examples: ["Every enabled alert rule routes somewhere"],
	}),
	severity: Schema.Literals(["critical", "warn", "info"]).annotate({
		description:
			"How bad a failure is: `critical` breaks a feature outright, `warn` degrades it, `info` is advisory. Fixed per check — it does not vary with the finding.",
		examples: ["critical"],
	}),
	status: Schema.Literals(["pass", "fail", "skip"]).annotate({
		description:
			"`pass` when the assertion holds, `fail` when it does not, `skip` when the check needs telemetry that was unavailable.",
		examples: ["fail"],
	}),
	detail: Schema.NullOr(Schema.String).annotate({
		description: "One-sentence description of the finding, or `null` when the check passed.",
		examples: ["2 enabled alert rules will evaluate and breach but deliver to nobody."],
	}),
	affected: Schema.Array(V2SetupAuditAffectedEntity).annotate({
		description: "The objects this finding points at, capped at 20 entries.",
	}),
	affected_count: Schema.Number.annotate({
		description: "Total affected objects before capping — may exceed `affected.length`.",
		examples: [2],
	}),
	fix_hint: Schema.String.annotate({
		description: "How to resolve the finding.",
		examples: ["Open each rule and pick at least one enabled destination under Notifications."],
	}),
}).annotate({
	identifier: "SetupAuditCheck",
	title: "Setup audit check",
	description: "The result of one setup audit check.",
})
export type V2SetupAuditCheck = Schema.Schema.Type<typeof V2SetupAuditCheck>

export const V2SetupAuditSummary = Schema.Struct({
	critical: Schema.Number.annotate({ description: "Failing checks with `critical` severity." }),
	warn: Schema.Number.annotate({ description: "Failing checks with `warn` severity." }),
	info: Schema.Number.annotate({ description: "Failing checks with `info` severity." }),
	pass: Schema.Number.annotate({ description: "Checks that passed." }),
	skip: Schema.Number.annotate({ description: "Checks skipped because telemetry was unavailable." }),
}).annotate({
	identifier: "SetupAuditSummary",
	title: "Setup audit summary",
	description: "Check counts by outcome. Always consistent with `checks`.",
})

export const V2SetupAudit = Schema.Struct({
	object: Schema.Literal("setup_audit").annotate({
		description: 'The object type — always `"setup_audit"`.',
		examples: ["setup_audit"],
	}),
	generated_at: Timestamp.annotate({
		description: "When the report was computed. Audits are recomputed per request, never cached as objects.",
	}),
	data_status: Schema.Literals(["ok", "no_data"]).annotate({
		description:
			"`no_data` means the organization has never received telemetry; `checks` is empty because connecting a service comes first.",
		examples: ["ok"],
	}),
	telemetry_checks_available: Schema.Boolean.annotate({
		description:
			"Whether telemetry-backed checks could run. When `false`, those checks report `skip` and the configuration checks still apply.",
		examples: [true],
	}),
	summary: V2SetupAuditSummary,
	checks: Schema.Array(V2SetupAuditCheck).annotate({
		description: "Every check, passing ones included, so the summary is verifiable from the payload.",
	}),
	open_recommendation_count: Schema.Number.annotate({
		description:
			"Open instrumentation recommendations. Retrieve them from `/v2/instrumentation/recommendations` — the audit summarizes rather than duplicates them.",
		examples: [3],
	}),
}).annotate({
	identifier: "SetupAudit",
	title: "Setup audit",
	description:
		"A point-in-time audit of the organization's Maple setup: whether alerts can actually deliver, whether every service is sending the signals you expect, whether attribute conventions hold, and whether traces arrive intact. Recomputed on every request.",
	examples: [
		wireExample({
			object: "setup_audit",
			generated_at: "2026-07-27T12:00:00.000Z",
			data_status: "ok",
			telemetry_checks_available: true,
			summary: { critical: 1, warn: 2, info: 0, pass: 15, skip: 0 },
			checks: [
				{
					object: "setup_audit_check",
					id: "CFG-ALERT-03",
					category: "alerting",
					title: "Every enabled alert rule routes somewhere",
					severity: "critical",
					status: "fail",
					detail: "1 enabled alert rule will evaluate and breach but deliver to nobody.",
					affected: [
						{
							kind: "alert_rule",
							id: "alrt_4CzLmR1pTx",
							name: "API error rate",
							note: "every selected destination is disabled or deleted",
						},
					],
					affected_count: 1,
					fix_hint: "Open each rule and pick at least one enabled destination under Notifications.",
				},
			],
			open_recommendation_count: 3,
		}),
	],
})
export type V2SetupAudit = Schema.Schema.Type<typeof V2SetupAudit>

export class V2InstrumentationAuditApiGroup extends HttpApiGroup.make("instrumentationAudit")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2SetupAudit,
			error: [V2InvalidRequestError, V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSetupAudit",
				summary: "Retrieve the setup audit",
				description:
					"Audits the organization's Maple setup and returns every check with its outcome. Covers alert routing and delivery health, error-notification wiring, ingest coverage per service, attribute conventions, trace completeness, and integration health. " +
					"Configuration checks always run; telemetry-backed checks report `skip` when the warehouse is unavailable, so this endpoint returns `503` only if configuration itself cannot be read. Requires the `instrumentation:read` scope.",
			}),
		),
	)
	.prefix("/v2/instrumentation/audit")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Setup Audit",
			description:
				"A health check for your Maple setup — what you are ingesting, whether alerts can reach you, and whether your telemetry follows the conventions Maple's features depend on.",
		}),
	) {}
