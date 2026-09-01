import { Option } from "effect"
import { parseUrl } from "@maple/domain/url"

const PUBLIC_GITHUB_WEB = "https://github.com"

/**
 * `GITHUB_API_BASE_URL` is the only host knob, but two GitHub URLs are not on
 * the API host: the OAuth code exchange and the App installation page both live
 * on the web host. Hardcoding `https://github.com` for those sent a GitHub
 * Enterprise deployment's OAuth client secret to public GitHub and pointed its
 * install flow at an app that does not exist there.
 *
 * Enterprise Server publishes its API under `https://<host>/api/v3`; public
 * GitHub splits the two across `api.github.com` and `github.com`.
 */
export const githubWebBaseUrl = (apiBaseUrl: string): string => {
	const decoded = parseUrl(apiBaseUrl.trim())
	if (Option.isNone(decoded)) return PUBLIC_GITHUB_WEB
	const url = decoded.value

	if (url.hostname === "api.github.com") return PUBLIC_GITHUB_WEB

	// Everything else is Enterprise Server, whose web root is the API URL minus
	// its `/api/v3` (GraphQL: `/api/graphql`) suffix.
	const path = url.pathname.replace(/\/(api\/v3|api\/graphql|api)\/?$/, "")
	return `${url.origin}${path}`.replace(/\/+$/, "")
}
