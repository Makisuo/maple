import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AiTriageIncidentKind } from "../ai-triage"
import { IssueSeverity } from "../errors"
import { InvestigationConfidence, InvestigationSeededBy, InvestigationStatus } from "../investigations"
import { TraceId, UserId } from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { encodePublicId, PublicIdPrefixes } from "./public-id"
import {
	AlertIncidentPublicId,
	AnomalyIncidentPublicId,
	ErrorIncidentPublicId,
	ErrorIssuePublicId,
	InvestigationPublicId,
} from "./resource-ids"

export { ErrorIssuePublicId, InvestigationPublicId } from "./resource-ids"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

// ---------------------------------------------------------------------------
// Subject (snake_case wire form of the internal InvestigationSubject union)
// ---------------------------------------------------------------------------

/** A page/entity context hint (structurally the web's AutoContext) — opaque JSON. */
const InvestigationContextRef = Schema.Record(Schema.String, Schema.Unknown)

const investigationIncidentSubjectBase = {
	type: Schema.Literal("incident").annotate({
		description: 'Discriminator — always `"incident"` for an incident-anchored investigation.',
	}),
}

const investigationIncidentVariants = <IssueId extends Schema.Top>(issueId: IssueId) =>
	Schema.Union([
		Schema.Struct({
			...investigationIncidentSubjectBase,
			issue_id: issueId,
			incident_kind: Schema.Literal("error"),
			incident_id: ErrorIncidentPublicId,
		}),
		Schema.Struct({
			...investigationIncidentSubjectBase,
			issue_id: issueId,
			incident_kind: Schema.Literal("anomaly"),
			incident_id: AnomalyIncidentPublicId,
		}),
		Schema.Struct({
			...investigationIncidentSubjectBase,
			issue_id: issueId,
			incident_kind: Schema.Literal("alert"),
			incident_id: AlertIncidentPublicId,
		}),
	])

export const V2InvestigationIncidentSubject = investigationIncidentVariants(
	Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The linked `iss_…` error issue, or `null` when the incident has none.",
	}),
).annotate({
	identifier: "InvestigationIncidentSubject",
	title: "Incident subject",
	description:
		"An investigation anchored to a typed incident. The public-ID prefix must match `incident_kind`: `einc_…`, `anom_…`, or `inc_…`.",
})

const V2InvestigationIncidentSubjectInput = investigationIncidentVariants(
	Schema.optionalKey(
		ErrorIssuePublicId.annotate({
			description: "The `iss_…` ID of the linked error issue, when the incident is backed by one.",
		}),
	),
)

export const V2InvestigationFreeformSubject = Schema.Struct({
	type: Schema.Literal("freeform").annotate({
		description: 'Discriminator — always `"freeform"` for an ad-hoc investigation.',
	}),
	title: Schema.String.annotate({ description: "Short human-readable title for the investigation." }),
	prompt: Schema.String.annotate({ description: "The question or task the investigation should answer." }),
	context_refs: Schema.Array(InvestigationContextRef).annotate({
		description:
			"Opaque context hints (services, traces, dashboards, …) passed through verbatim for the agent to read as JSON.",
	}),
}).annotate({
	identifier: "InvestigationFreeformSubject",
	title: "Freeform subject",
	description: "An ad-hoc investigation into a user-supplied question with optional context.",
})

export const V2InvestigationSubject = Schema.Union([
	V2InvestigationIncidentSubject,
	V2InvestigationFreeformSubject,
]).annotate({
	identifier: "InvestigationSubject",
	title: "Investigation subject",
	description: "What is being investigated — a typed incident or an ad-hoc question.",
})
export type V2InvestigationSubject = Schema.Schema.Type<typeof V2InvestigationSubject>

export const V2InvestigationCreateSubject = Schema.Union([
	V2InvestigationIncidentSubjectInput,
	V2InvestigationFreeformSubject,
])
export type V2InvestigationCreateSubject = Schema.Schema.Type<typeof V2InvestigationCreateSubject>

const V2AiTriageEvidence = Schema.Struct({
	traceIds: Schema.Array(TraceId),
	logPatterns: Schema.Array(Schema.String),
	relatedServices: Schema.Array(Schema.String),
	note: Schema.String,
}).pipe(
	Schema.encodeKeys({
		traceIds: "trace_ids",
		logPatterns: "log_patterns",
		relatedServices: "related_services",
	}),
)

/** Snake-case v2 wire projection of the internal AI triage result. */
const V2AiTriageResult = Schema.Struct({
	summary: Schema.String,
	suspectedCause: Schema.String,
	severityAssessment: IssueSeverity,
	affectedScope: Schema.String,
	evidence: Schema.Array(V2AiTriageEvidence),
	suggestedActions: Schema.Array(Schema.String),
	confidence: Schema.Literals(["high", "medium", "low"]),
}).pipe(
	Schema.encodeKeys({
		suspectedCause: "suspected_cause",
		severityAssessment: "severity_assessment",
		affectedScope: "affected_scope",
		suggestedActions: "suggested_actions",
	}),
)

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

const investigationExample = {
	id: "inv_YofPTrK9782DWwcnXhpcCw",
	object: "investigation",
	status: "diagnosed",
	subject: {
		type: "incident",
		incident_kind: "error",
		incident_id: encodePublicId(PublicIdPrefixes.errorIncident, "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8"),
		issue_id: "iss_YofPTrK9782DWwcnXhpcCw",
	},
	report: null,
	model: "claude-opus-4-8",
	severity: "high",
	confidence: "high",
	seeded_by: "system",
	created_by: null,
	input_tokens: 12000,
	output_tokens: 800,
	error: null,
	created_at: "2026-07-15T09:12:00.000Z",
	diagnosed_at: "2026-07-15T09:12:42.000Z",
	updated_at: "2026-07-15T09:12:42.000Z",
} as const

export const V2Investigation = Schema.Struct({
	id: InvestigationPublicId,
	object: Schema.Literal("investigation").annotate({
		description: 'The object type — always `"investigation"`.',
		examples: ["investigation"],
	}),
	status: InvestigationStatus.annotate({
		description:
			"Lifecycle state: `investigating` (diagnostic pass in progress), `diagnosed` (report attached), `resolved` (human-closed), or `failed`.",
		examples: ["diagnosed"],
	}),
	subject: V2InvestigationSubject,
	report: Schema.NullOr(V2AiTriageResult).annotate({
		description:
			"The latest structured AI diagnosis, or `null` until the first diagnosis lands. The report's internal fields are an evolving shape — treat it as a diagnosis blob, not a stability-committed schema.",
	}),
	model: Schema.NullOr(Schema.String).annotate({
		description: "The model that produced the diagnosis, or `null`.",
	}),
	severity: Schema.NullOr(IssueSeverity).annotate({
		description: "Severity denormalized from the report for cheap list rendering, or `null`.",
	}),
	confidence: Schema.NullOr(InvestigationConfidence).annotate({
		description: "The diagnosis confidence (`high`/`medium`/`low`), or `null`.",
	}),
	seeded_by: InvestigationSeededBy.annotate({
		description: "Who opened the investigation: `user` (attended) or `system` (incident-open trigger).",
	}),
	created_by: Schema.NullOr(UserId).annotate({
		description: "The `user_…` ID that opened the investigation, or `null` for system-seeded ones.",
	}),
	input_tokens: Schema.NullOr(Schema.Number).annotate({
		description: "Input tokens consumed by the diagnostic pass, or `null`.",
	}),
	output_tokens: Schema.NullOr(Schema.Number).annotate({
		description: "Output tokens produced by the diagnostic pass, or `null`.",
	}),
	error: Schema.NullOr(Schema.String).annotate({
		description: "The failure message if the diagnostic pass errored, or `null`.",
	}),
	created_at: Timestamp.annotate({ description: "When the investigation was opened." }),
	diagnosed_at: Schema.NullOr(Timestamp).annotate({
		description: "When a diagnosis was first attached, or `null`.",
	}),
	updated_at: Timestamp.annotate({ description: "When the investigation was last updated." }),
}).annotate({
	identifier: "Investigation",
	title: "Investigation",
	description:
		"A durable investigation 'war-room' — an autonomous or human-opened diagnostic session over an incident or an ad-hoc question. Carries the structured AI diagnosis once it lands.",
	examples: [wireExample(investigationExample)],
})
export type V2Investigation = Schema.Schema.Type<typeof V2Investigation>

// ---------------------------------------------------------------------------
// Requests / queries
// ---------------------------------------------------------------------------

export const V2InvestigationCreateParams = Schema.Struct({
	subject: V2InvestigationCreateSubject,
}).annotate({
	identifier: "InvestigationCreateParams",
	title: "Investigation create parameters",
	description:
		"Request body for opening an investigation. Incident-anchored investigations dedup to one per incident.",
	examples: [
		wireExample({
			subject: {
				type: "incident",
				incident_kind: "error",
				incident_id: encodePublicId(
					PublicIdPrefixes.errorIncident,
					"018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8",
				),
			},
		}),
	],
})
export type V2InvestigationCreateParams = Schema.Schema.Type<typeof V2InvestigationCreateParams>

export const V2InvestigationStatusUpdateParams = Schema.Struct({
	status: InvestigationStatus.annotate({
		description: "The new lifecycle status.",
		examples: ["resolved"],
	}),
}).annotate({
	identifier: "InvestigationStatusUpdateParams",
	title: "Investigation status update parameters",
	description: "Request body for changing an investigation's lifecycle status.",
	examples: [wireExample({ status: "resolved" })],
})
export type V2InvestigationStatusUpdateParams = Schema.Schema.Type<typeof V2InvestigationStatusUpdateParams>

export const V2InvestigationsListQuery = Schema.Struct({
	...ListQuery.fields,
	status: Schema.optional(
		InvestigationStatus.annotate({ description: "Only return investigations in this status." }),
	),
	issue_id: Schema.optional(
		ErrorIssuePublicId.annotate({
			description: "Only return investigations for this `iss_…` error issue.",
		}),
	),
	incident_kind: Schema.optional(
		AiTriageIncidentKind.annotate({ description: "Only return investigations for this incident kind." }),
	),
	incident_id: Schema.optional(
		Schema.Union([ErrorIncidentPublicId, AnomalyIncidentPublicId, AlertIncidentPublicId]).annotate({
			description: "Only return investigations for this prefixed incident ID.",
		}),
	),
}).annotate({
	identifier: "InvestigationsListQuery",
	title: "Investigations list query",
	description: "Pagination plus optional filters for the investigations list.",
})
export type V2InvestigationsListQuery = Schema.Schema.Type<typeof V2InvestigationsListQuery>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const InvestigationList = ListOf(V2Investigation).annotate({
	identifier: "InvestigationList",
	title: "Investigation list",
	description: "A cursor-paginated page of investigations, newest first.",
})

export class V2InvestigationsApiGroup extends HttpApiGroup.make("investigations")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2InvestigationsListQuery,
			success: InvestigationList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listInvestigations",
				summary: "List investigations",
				description:
					"Returns your organization's investigations, newest first, optionally filtered by status, error issue, or incident. Cursor-paginated. Requires the `investigations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: InvestigationPublicId },
			success: V2Investigation,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getInvestigation",
				summary: "Retrieve an investigation",
				description:
					"Returns a single investigation by its `inv_…` ID, including its diagnosis when one exists. Requires the `investigations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2InvestigationCreateParams,
			success: V2Investigation,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createInvestigation",
				summary: "Open an investigation",
				description:
					"Opens an investigation over an incident or an ad-hoc question. Incident-anchored investigations return the existing war-room if one is already open. Requires the `investigations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("updateStatus", "/:id/status", {
			params: { id: InvestigationPublicId },
			payload: V2InvestigationStatusUpdateParams,
			success: V2Investigation,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateInvestigationStatus",
				summary: "Update investigation status",
				description:
					"Changes an investigation's lifecycle status (e.g. resolve it). Requires the `investigations:write` scope.",
			}),
		),
	)
	.prefix("/v2/investigations")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Investigations",
			description:
				"Durable investigation war-rooms — autonomous or human-opened diagnostic sessions over incidents and ad-hoc questions, each carrying its structured AI diagnosis.",
		}),
	) {}
