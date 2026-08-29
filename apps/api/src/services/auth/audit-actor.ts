import { Context } from "effect"
import type { AuditLogSource } from "@maple/domain/http"
import type { ApiKeyId } from "@maple/domain/primitives"

/**
 * How the current request authenticated, for audit attribution. The tenant
 * context deliberately does not say whether a request came from a dashboard
 * session, an API key, or MCP — this reference carries those two facts, which
 * nothing downstream can re-derive.
 */
export interface AuditActorInfo {
	/** `system` is Maple itself acting through an internal service token. */
	readonly type: "user" | "api_key" | "system"
	readonly apiKeyId?: ApiKeyId
	/** The surface the request arrived through, recorded as the entry's `source`. */
	readonly source: AuditLogSource
}

/**
 * A reference (typed default, no handler requirement) rather than a service:
 * the auth middlewares override it per request, and handlers that never record
 * audit entries are unaffected. `undefined` means the request skipped the
 * standard auth middlewares (internal tokens, queue consumers, crons) — callers
 * must then fall back to whatever attribution they can establish themselves,
 * never assume a dashboard session.
 */
export class CurrentAuditActor extends Context.Reference<AuditActorInfo | undefined>(
	"@maple/api/services/auth/CurrentAuditActor",
	{ defaultValue: () => undefined },
) {}
