import { Context, Effect } from "effect"
import type { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { AuditedRead, type AuditLogSource } from "@maple/domain/http"
import type { ActorId, OrgId, UserId } from "@maple/domain/primitives"
import type { McpToolSurface } from "@/mcp/dispatcher"
import type { AuditActorInfo } from "@/services/auth/audit-actor"
import { CurrentAuditActor } from "@/services/auth/audit-actor"
import type { TenantContext } from "@/services/auth/tenant-context"
import {
	type AuditActorRef,
	AuditLogService,
	type AuditLogServiceApi,
	currentRequestForensics,
	httpRequestForensics,
} from "./AuditLogService"

/**
 * Access auditing: who read what. HIPAA's audit-control standard covers every
 * access to protected data, not only changes, so three read surfaces record
 * entries alongside the mutation trail —
 *
 * - HTTP endpoints annotated `AuditedRead` (telemetry and session replays),
 *   wrapped by the auth layers via {@link withAuditedRead};
 * - every MCP tool invocation, from the executor via {@link recordMcpToolAudit};
 * - every raw SQL statement, via {@link recordRawSqlAudit}.
 */

/** Bound on stored request/parameter snapshots — enough to see what was asked for. */
const MAX_SNAPSHOT_CHARS = 2_000

/** A JSON rendering of `value` capped at {@link MAX_SNAPSHOT_CHARS}. */
export const snapshot = (value: unknown): string => {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null")
	return text.length > MAX_SNAPSHOT_CHARS ? `${text.slice(0, MAX_SNAPSHOT_CHARS)}…` : text
}

export interface AuditAttribution {
	readonly actor: AuditActorRef
	readonly source: AuditLogSource
}

/**
 * Attribute an action performed under `tenant`. The credential and surface
 * come from the auth layer's `CurrentAuditActor` when one set it; an agent
 * tenant (pinned `actorId`) is recorded as the agent acting on the user's
 * behalf; nothing set means a dashboard session, never a guessed credential.
 */
/** The tenant facts attribution needs; both `TenantContext` and `TenantSchema` satisfy it. */
export interface AuditTenant {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly actorId?: ActorId | undefined
	readonly mcpClientName?: string | undefined
}

export const auditAttribution = (tenant: AuditTenant, info: AuditActorInfo | undefined): AuditAttribution => {
	if (info?.type === "system") return { actor: { type: "system" }, source: "system" }
	if (tenant.actorId !== undefined) {
		return {
			actor: {
				type: "agent",
				actorId: tenant.actorId,
				userId: tenant.userId,
				...(tenant.mcpClientName !== undefined ? { label: tenant.mcpClientName } : undefined),
			},
			source: info?.source ?? "mcp",
		}
	}
	return {
		actor: {
			type: info?.type ?? "user",
			userId: tenant.userId,
			...(info?.apiKeyId !== undefined ? { apiKeyId: info.apiKeyId } : undefined),
			...(info?.label !== undefined ? { label: info.label } : undefined),
		},
		source: info?.source ?? "dashboard",
	}
}

export interface AuditedReadSubject extends AuditAttribution {
	readonly orgId: OrgId
}

/**
 * Wrap an authenticated endpoint response so that, when the endpoint is
 * annotated `AuditedRead`, the call is recorded once it completes — with the
 * HTTP status, the route, the request path, and (for POST searches) a bounded
 * snapshot of the body that says what was queried. A typed failure still
 * records an attempt; an interrupt records nothing.
 */
export const withAuditedRead =
	(
		audit: AuditLogServiceApi,
		request: HttpServerRequest.HttpServerRequest,
		options: { readonly endpoint: HttpApiEndpoint.Top; readonly group: HttpApiGroup.Top },
		subject: AuditedReadSubject,
	) =>
	<E, R>(
		httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
	): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> => {
		// A group-level `.annotate` lands on the group only (endpoint propagation
		// is `annotateEndpoints`), so both are consulted; the endpoint wins.
		const action =
			Context.get(options.endpoint.annotations, AuditedRead) ??
			Context.get(options.group.annotations, AuditedRead)
		if (action === undefined) return httpEffect
		const record = (status: number) =>
			Effect.gen(function* () {
				// The handler already consumed (and cached) the body, so this is a
				// read of the same text, never a second parse of the stream.
				const body =
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: yield* request.text.pipe(Effect.option)
				yield* audit.record({
					orgId: subject.orgId,
					actor: subject.actor,
					source: subject.source,
					action,
					metadata: {
						endpoint: `${options.group.identifier}.${options.endpoint.identifier}`,
						method: request.method,
						path: request.url,
						status,
						...(body !== undefined && body._tag === "Some" && body.value !== ""
							? { body: snapshot(body.value) }
							: undefined),
					},
					...httpRequestForensics(request),
				})
			})
		return httpEffect.pipe(
			Effect.tap((response) => record(response.status)),
			// A rejected read (bad parameters, not found) is still an attempt;
			// 0 says the status was never produced.
			Effect.tapError(() => record(0)),
		)
	}

export interface McpToolAuditInput {
	readonly tenant: TenantContext
	readonly name: string
	readonly input: unknown
	readonly surface: McpToolSurface
	readonly isError: boolean
}

/**
 * One `mcp_tool.called` entry per tool invocation, whichever surface drove it.
 * Workflow passes and internal RPC run under Maple's own tenant, so they are
 * `system`; the public transport and the chat attribute through the tenant.
 */
export const recordMcpToolAudit = (input: McpToolAuditInput) =>
	Effect.gen(function* () {
		const audit = yield* AuditLogService
		const info = yield* CurrentAuditActor
		const forensics = yield* currentRequestForensics
		const attribution =
			input.surface === "workflow" || input.surface === "rpc"
				? { actor: { type: "system" as const, label: input.surface }, source: "system" as const }
				: auditAttribution(input.tenant, info)
		yield* audit.record({
			orgId: input.tenant.orgId,
			...attribution,
			action: "mcp_tool.called",
			metadata: {
				tool: input.name,
				surface: input.surface,
				is_error: input.isError,
				params: snapshot(input.input),
			},
			...forensics,
		})
	})

export type RawSqlAuditResult =
	| { readonly _tag: "rows"; readonly rowCount: number }
	/** The safety pass refused the statement before it ran. */
	| { readonly _tag: "rejected"; readonly reason: string }
	/** The warehouse refused or failed the statement. */
	| { readonly _tag: "failed"; readonly error: string }

export interface RawSqlAuditInput {
	readonly tenant: AuditTenant
	readonly sql: string
	/** The executor context label: `mcp.run_sql`, `rawSql`, … */
	readonly context: string
	readonly startTime: string
	readonly endTime: string
	readonly result: RawSqlAuditResult
}

/**
 * One `telemetry.sql_executed` entry per raw SQL statement — the statement
 * itself, the window it ran over, and how it ended. A statement the safety
 * pass refused is a `denied` entry: an attempt to read outside the guardrails
 * is exactly what an auditor asks about.
 */
export const recordRawSqlAudit = (input: RawSqlAuditInput) =>
	Effect.gen(function* () {
		const audit = yield* AuditLogService
		const info = yield* CurrentAuditActor
		const forensics = yield* currentRequestForensics
		const { actor, source } = auditAttribution(input.tenant, info)
		yield* audit.record({
			orgId: input.tenant.orgId,
			actor,
			source,
			action: "telemetry.sql_executed",
			...(input.result._tag === "rejected"
				? { outcome: "denied", denialReason: input.result.reason }
				: undefined),
			metadata: {
				sql: snapshot(input.sql),
				context: input.context,
				start_time: input.startTime,
				end_time: input.endTime,
				...(input.result._tag === "rows" ? { row_count: input.result.rowCount } : undefined),
				...(input.result._tag === "failed" ? { error: input.result.error } : undefined),
			},
			...forensics,
		})
	})

/** A one-line description of a typed failure for the audit metadata. */
export const describeFailure = (error: { readonly _tag: string; readonly message?: string }): string =>
	error.message ?? error._tag
