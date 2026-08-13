import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"

/**
 * The organization the **API** resolved this session to, or `null` while that is
 * still loading.
 *
 * This deliberately does not read Clerk's active organization. The server is the
 * authority on which tenant a session belongs to, and the two do not always
 * agree: `packages/auth` resolves `MAPLE_ORG_ID_OVERRIDE ?? auth.orgId`, and in
 * self-hosted mode the org comes from the session token rather than a constant.
 * A client-side guess that disagrees fails silently and totally — the chat
 * addresses its agent as `"<orgId>:<tabId>"`, so a wrong org opens a conversation
 * nobody else can see, and an investigation's thread stays empty forever with no
 * error raised anywhere.
 *
 * `GET /api/auth/session` returns the resolved tenant, and other hooks already
 * read this same atom, so this costs no extra request.
 */
export function useMapleOrganizationId(): string | null {
	const sessionResult = useAtomValue(retainedQuery("auth", "session", {}))

	return Result.builder(sessionResult)
		.onSuccess((session) => session.orgId as string)
		.orElse(() => null)
}
