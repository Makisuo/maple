import { Effect, Schema } from "effect"
import { RoleName } from "@maple/domain/http"

const ROOT_ROLE = Schema.decodeUnknownSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeUnknownSync(RoleName)("org:admin")

const ADMIN_ROLES: ReadonlyArray<RoleName> = [ROOT_ROLE, ORG_ADMIN_ROLE]

export const isAdmin = (roles: ReadonlyArray<RoleName>): boolean =>
	roles.some((role) => ADMIN_ROLES.includes(role))

/**
 * Gate a handler on org-admin / root role membership. Threads through a
 * caller-supplied error factory so each route group can fail with its own
 * tagged ForbiddenError (kept domain-local for status-code mapping).
 */
export const requireAdmin = <E>(
	roles: ReadonlyArray<RoleName>,
	makeError: () => E,
): Effect.Effect<void, E> => (isAdmin(roles) ? Effect.void : Effect.fail(makeError()))
