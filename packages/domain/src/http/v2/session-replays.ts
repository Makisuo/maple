import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { SessionId, TraceId } from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

/** `srep_…` public ID ⇄ internal `SessionId` (free-form string). */
export const SessionReplayPublicId = PublicId(PublicIdPrefixes.sessionReplay, SessionId)

const EXAMPLE_ID = "srep_4yeq2Gm3r2drGjuAHorp"

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Fields shared by the list summary and the full detail object. */
const sessionReplayBaseFields = {
	id: SessionReplayPublicId,
	object: Schema.Literal("session_replay").annotate({
		description: 'The object type — always `"session_replay"`.',
		examples: ["session_replay"],
	}),
	start_time: Timestamp.annotate({ description: "When the session started." }),
	end_time: Schema.NullOr(Timestamp).annotate({
		description: "When the session ended, or `null` if ongoing.",
	}),
	duration_ms: Schema.NullOr(Schema.Number).annotate({
		description: "Session wall-clock duration in ms, or `null`.",
	}),
	status: Schema.String.annotate({ description: "Session status (e.g. `active`, `ended`)." }),
	user_id: Schema.NullOr(Schema.String).annotate({
		description: "The identified user, or `null` if anonymous.",
	}),
	url_initial: Schema.String.annotate({ description: "The first URL of the session." }),
	browser_name: Schema.String.annotate({ description: "Browser name." }),
	os_name: Schema.String.annotate({ description: "Operating system name." }),
	device_type: Schema.String.annotate({ description: "Device type (e.g. `desktop`, `mobile`)." }),
	country: Schema.String.annotate({ description: "Country the session originated from." }),
	service_name: Schema.String.annotate({ description: "Service the session was recorded on." }),
	page_views: Schema.Number.annotate({ description: "Number of page views in the session." }),
	click_count: Schema.Number.annotate({ description: "Number of clicks in the session." }),
	error_count: Schema.Number.annotate({ description: "Number of errors recorded in the session." }),
	trace_count: Schema.Number.annotate({ description: "Number of correlated traces." }),
} as const

export const V2SessionReplayListItem = Schema.Struct(sessionReplayBaseFields).annotate({
	identifier: "SessionReplayListItem",
	title: "Session replay",
	description: "A recorded browser session — summary form returned by search.",
	examples: [
		wireExample({
			id: EXAMPLE_ID,
			object: "session_replay",
			start_time: "2026-07-15T09:12:00.000Z",
			end_time: "2026-07-15T09:18:30.000Z",
			duration_ms: 390000,
			status: "ended",
			user_id: "user_2abc",
			url_initial: "https://app.example.com/dashboard",
			browser_name: "Chrome",
			os_name: "macOS",
			device_type: "desktop",
			country: "US",
			service_name: "web",
			page_views: 5,
			click_count: 24,
			error_count: 1,
			trace_count: 12,
		}),
	],
})
export type V2SessionReplayListItem = Schema.Schema.Type<typeof V2SessionReplayListItem>

export const V2SessionReplay = Schema.Struct({
	...sessionReplayBaseFields,
	user_agent: Schema.String.annotate({ description: "The full user-agent string." }),
	trace_ids: Schema.Array(TraceId).annotate({ description: "All trace IDs correlated to the session." }),
	resource_attributes: Schema.String.annotate({
		description: "The session's OTel resource attributes, JSON-encoded.",
	}),
	active_time_ms: Schema.NullOr(Schema.Number).annotate({
		description: "Active (non-idle) time in ms, or `null` when the session has no distilled events.",
	}),
	idle_time_ms: Schema.NullOr(Schema.Number).annotate({ description: "Idle time in ms, or `null`." }),
}).annotate({
	identifier: "SessionReplay",
	title: "Session replay (detail)",
	description: "A recorded browser session with full detail, returned by retrieve.",
	examples: [
		wireExample({
			id: EXAMPLE_ID,
			object: "session_replay",
			start_time: "2026-07-15T09:12:00.000Z",
			end_time: "2026-07-15T09:18:30.000Z",
			duration_ms: 390000,
			status: "ended",
			user_id: "user_2abc",
			url_initial: "https://app.example.com/dashboard",
			browser_name: "Chrome",
			os_name: "macOS",
			device_type: "desktop",
			country: "US",
			service_name: "web",
			page_views: 5,
			click_count: 24,
			error_count: 1,
			trace_count: 12,
			user_agent: "Mozilla/5.0 …",
			trace_ids: [],
			resource_attributes: "{}",
			active_time_ms: 240000,
			idle_time_ms: 150000,
		}),
	],
})
export type V2SessionReplay = Schema.Schema.Type<typeof V2SessionReplay>

export const V2SessionReplayChunk = Schema.Struct({
	object: Schema.Literal("session_replay.event_chunk").annotate({
		description: 'The object type — always `"session_replay.event_chunk"`.',
	}),
	chunk_seq: Schema.Number.annotate({ description: "Ordinal of the chunk within the session." }),
	timestamp: Timestamp.annotate({ description: "When the chunk's events start." }),
	duration_ms: Schema.Number.annotate({ description: "Duration covered by the chunk in ms." }),
	event_count: Schema.Number.annotate({ description: "Number of rrweb events in the chunk." }),
	byte_size: Schema.Number.annotate({ description: "Serialized size of the chunk in bytes." }),
	is_checkpoint: Schema.Boolean.annotate({
		description: "Whether the chunk is a full-snapshot checkpoint.",
	}),
	events: Schema.String.annotate({
		description: "The rrweb event array for this chunk, serialized as a JSON string.",
	}),
}).annotate({
	identifier: "SessionReplayChunk",
	title: "Session replay event chunk",
	description: "One chunk of rrweb events for a session, payload inline.",
})
export type V2SessionReplayChunk = Schema.Schema.Type<typeof V2SessionReplayChunk>

export const V2SessionTranscriptEvent = Schema.Struct({
	object: Schema.Literal("session_replay.transcript_event").annotate({
		description: 'The object type — always `"session_replay.transcript_event"`.',
	}),
	timestamp: Timestamp.annotate({ description: "When the event occurred." }),
	seq: Schema.Number.annotate({ description: "Ordinal of the event within the session." }),
	type: Schema.String.annotate({
		description: "Event type (navigation, click, network, console, error, …).",
	}),
	url: Schema.String.annotate({ description: "The page URL at the time of the event." }),
	trace_id: Schema.NullOr(TraceId).annotate({ description: "Correlated trace ID, or `null`." }),
	level: Schema.NullOr(Schema.String).annotate({
		description: "Severity/level for console and error events, otherwise `null`.",
	}),
	message: Schema.NullOr(Schema.String).annotate({
		description: "The event message when this event carries one, otherwise `null`.",
	}),
	target_selector: Schema.NullOr(Schema.String).annotate({
		description: "CSS selector of the interaction target, otherwise `null`.",
	}),
	target_text: Schema.NullOr(Schema.String).annotate({
		description: "Text of the interaction target, otherwise `null`.",
	}),
	net_method: Schema.NullOr(Schema.String).annotate({
		description: "HTTP method for network events, otherwise `null`.",
	}),
	net_url: Schema.NullOr(Schema.String).annotate({
		description: "Request URL for network events, otherwise `null`.",
	}),
	net_status: Schema.NullOr(Schema.Number).annotate({
		description: "Response status for network events, otherwise `null`.",
	}),
	net_duration_ms: Schema.NullOr(Schema.Number).annotate({
		description: "Request duration in ms for network events, otherwise `null`.",
	}),
	error_stack: Schema.NullOr(Schema.String).annotate({
		description: "Stack trace for error events, otherwise `null`.",
	}),
}).annotate({
	identifier: "SessionTranscriptEvent",
	title: "Session transcript event",
	description: "One distilled event in a session's transcript.",
})
export type V2SessionTranscriptEvent = Schema.Schema.Type<typeof V2SessionTranscriptEvent>

export const V2SessionReplayRef = Schema.Struct({
	object: Schema.Literal("session_replay.ref").annotate({
		description: 'The object type — always `"session_replay.ref"`.',
	}),
	id: SessionReplayPublicId,
	start_time: Timestamp.annotate({ description: "When the session started." }),
	duration_ms: Schema.NullOr(Schema.Number).annotate({ description: "Session duration in ms, or `null`." }),
}).annotate({
	identifier: "SessionReplayRef",
	title: "Session replay reference",
	description: "A lightweight reference to a session correlated with a trace.",
})
export type V2SessionReplayRef = Schema.Schema.Type<typeof V2SessionReplayRef>

// ---------------------------------------------------------------------------
// Requests / queries
// ---------------------------------------------------------------------------

export const V2SessionReplaySearchParams = Schema.Struct({
	start_time: Timestamp.annotate({ description: "Window start (ISO-8601). Required." }),
	end_time: Timestamp.annotate({ description: "Window end (ISO-8601). Required." }),
	service_name: Schema.optionalKey(Schema.String.annotate({ description: "Filter by service." })),
	browser: Schema.optionalKey(Schema.String.annotate({ description: "Filter by browser." })),
	country: Schema.optionalKey(Schema.String.annotate({ description: "Filter by country." })),
	device_type: Schema.optionalKey(Schema.String.annotate({ description: "Filter by device type." })),
	user_id: Schema.optionalKey(Schema.String.annotate({ description: "Filter by identified user." })),
	has_errors: Schema.optionalKey(
		Schema.Boolean.annotate({ description: "Only sessions with (or without) errors." }),
	),
	search: Schema.optionalKey(Schema.String.annotate({ description: "Free-text search over URL/user." })),
	duration_min_ms: Schema.optionalKey(
		Schema.Number.annotate({ description: "Minimum session duration in ms." }),
	),
	duration_max_ms: Schema.optionalKey(
		Schema.Number.annotate({ description: "Maximum session duration in ms." }),
	),
	active_time_min_ms: Schema.optionalKey(
		Schema.Number.annotate({ description: "Minimum active (non-idle) time in ms." }),
	),
	active_time_max_ms: Schema.optionalKey(
		Schema.Number.annotate({ description: "Maximum active (non-idle) time in ms." }),
	),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
			description: "Maximum number of sessions to return (1–100, default 20).",
		}),
	),
	cursor: Schema.optionalKey(
		Schema.String.annotate({ description: "Opaque pagination cursor from a prior response." }),
	),
}).annotate({
	identifier: "SessionReplaySearchParams",
	title: "Session replay search parameters",
	description: "Filters, required time window, and pagination for searching session replays.",
	examples: [
		wireExample({
			start_time: "2026-07-15T00:00:00.000Z",
			end_time: "2026-07-16T00:00:00.000Z",
			has_errors: true,
		}),
	],
})
export type V2SessionReplaySearchParams = Schema.Schema.Type<typeof V2SessionReplaySearchParams>

export const V2SessionReplayWindowQuery = Schema.Struct({
	window_start: Schema.optional(
		Timestamp.annotate({ description: "Optional session-window start (ISO-8601) to prune partitions." }),
	),
	window_end: Schema.optional(
		Timestamp.annotate({ description: "Optional session-window end (ISO-8601) to prune partitions." }),
	),
}).annotate({
	identifier: "SessionReplayWindowQuery",
	title: "Session replay window query",
	description:
		"Pagination plus an optional time window to prune warehouse partitions for a single-session read.",
})
export type V2SessionReplayWindowQuery = Schema.Schema.Type<typeof V2SessionReplayWindowQuery>

export const V2SessionReplayCollectionQuery = Schema.Struct({
	...ListQuery.fields,
	...V2SessionReplayWindowQuery.fields,
}).annotate({
	identifier: "SessionReplayCollectionQuery",
	title: "Session replay collection query",
	description: "Pagination plus an optional time window for replay child collections.",
})

export const V2SessionReplaysForTraceParams = Schema.Struct({
	trace_id: TraceId.annotate({ description: "The trace ID to find sessions for." }),
	start_time: Timestamp.annotate({ description: "Window start (ISO-8601)." }),
	end_time: Timestamp.annotate({ description: "Window end (ISO-8601)." }),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
			description: "Maximum number of session references to return (1–100, default 20).",
		}),
	),
	cursor: Schema.optionalKey(
		Schema.String.annotate({ description: "Opaque pagination cursor from a prior response." }),
	),
}).annotate({
	identifier: "SessionReplaysForTraceParams",
	title: "Sessions-for-trace parameters",
	description: "Find the sessions that contain a given trace.",
})
export type V2SessionReplaysForTraceParams = Schema.Schema.Type<typeof V2SessionReplaysForTraceParams>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const SessionReplayList = ListOf(V2SessionReplayListItem).annotate({
	identifier: "SessionReplayList",
	title: "Session replay list",
	description: "A cursor-paginated page of session replays, newest first.",
})

const SessionReplayChunkList = ListOf(V2SessionReplayChunk).annotate({
	identifier: "SessionReplayChunkList",
	title: "Session replay chunk list",
	description: "A cursor-paginated page of rrweb event chunks, in order.",
})

const SessionTranscriptList = ListOf(V2SessionTranscriptEvent).annotate({
	identifier: "SessionTranscriptList",
	title: "Session transcript list",
	description: "A cursor-paginated page of distilled transcript events, in order.",
})

const SessionReplayRefList = ListOf(V2SessionReplayRef).annotate({
	identifier: "SessionReplayRefList",
	title: "Session replay reference list",
	description: "A cursor-paginated page of session references correlated to a trace.",
})

export class V2SessionReplaysApiGroup extends HttpApiGroup.make("sessionReplays")
	.add(
		HttpApiEndpoint.post("search", "/search", {
			payload: V2SessionReplaySearchParams,
			success: SessionReplayList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "searchSessionReplays",
				summary: "Search session replays",
				description:
					"Searches recorded browser sessions within a time window, with optional filters. Cursor-paginated. Requires the `session_replays:read` scope. (For reverse correlation from a trace, use `POST /v2/session_replays/for_trace`.)",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: SessionReplayPublicId },
			query: V2SessionReplayWindowQuery,
			success: V2SessionReplay,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSessionReplay",
				summary: "Retrieve a session replay",
				description:
					"Returns a single session replay by its `srep_…` ID with full detail. Requires the `session_replays:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("events", "/:id/events", {
			params: { id: SessionReplayPublicId },
			query: V2SessionReplayCollectionQuery,
			success: SessionReplayChunkList,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSessionReplayEvents",
				summary: "List session replay events",
				description:
					"Returns the session's rrweb event chunks (player payload) in order. Cursor-paginated. Requires the `session_replays:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("transcript", "/:id/transcript", {
			params: { id: SessionReplayPublicId },
			query: V2SessionReplayCollectionQuery,
			success: SessionTranscriptList,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSessionReplayTranscript",
				summary: "List session transcript events",
				description:
					"Returns the session's distilled transcript (navigation, clicks, network, console, errors) in order. Cursor-paginated. Requires the `session_replays:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("forTrace", "/for_trace", {
			payload: V2SessionReplaysForTraceParams,
			success: SessionReplayRefList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listSessionReplaysForTrace",
				summary: "Find sessions for a trace",
				description:
					"Returns lightweight references to the sessions that contain a given trace. Cursor-paginated. Requires the `session_replays:read` scope.",
			}),
		),
	)
	.prefix("/v2/session_replays")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Session Replays",
			description:
				"Recorded browser sessions — search them, retrieve detail, stream rrweb event chunks, read the distilled transcript, and reverse-correlate from a trace.",
		}),
	) {}
