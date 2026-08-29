import { Context } from "effect"
import type { ApiKeyId } from "@maple/domain/primitives"

/**
 * How the current HTTP request authenticated, for audit attribution. The
 * tenant context deliberately does not say whether a request came from a
 * dashboard session or an API key — this reference carries that one fact.
 */
export interface AuditActorInfo {
	readonly type: "user" | "api_key"
	readonly apiKeyId?: ApiKeyId
}

/**
 * A reference (typed default, no handler requirement) rather than a service:
 * the auth middlewares override it per request, and handlers that never record
 * audit entries are unaffected. `undefined` means the request skipped the
 * standard auth middlewares (internal tokens, tests).
 */
export class CurrentAuditActor extends Context.Reference<AuditActorInfo | undefined>(
	"@maple/api/services/auth/CurrentAuditActor",
	{ defaultValue: () => undefined },
) {}
