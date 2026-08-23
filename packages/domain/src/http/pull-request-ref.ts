/**
 * Parsing the two string forms that tie a pull request to an issue: a PR URL
 * (what a human pastes and what an agent hands to `propose_fix`), and a Maple
 * issue reference found inside a PR's title or body (what the webhook scans for
 * when nobody linked anything explicitly).
 *
 * Both live in the domain rather than in the GitHub vendor directory: the link
 * they produce is issue-shaped, the auto-scan needs the app's own URL format,
 * and neither needs a provider client to run — which is what makes them
 * testable without one.
 */

export interface ParsedPullRequestUrl {
	readonly provider: "github"
	readonly owner: string
	readonly repo: string
	readonly repoFullName: string
	readonly number: number
	/** Normalized: canonical host, no query, no fragment, no trailing segments. */
	readonly url: string
}

// GitHub PR URLs, and only those, since `VcsProviderId` has no other member.
// `/files`, `/commits`, and `#discussion_r…` suffixes are common in a pasted
// link and are dropped rather than rejected — the user pasting from a review tab
// means the same PR.
const GITHUB_PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/

/**
 * A pull-request URL, or null if the string is not one.
 *
 * Null rather than a thrown error or a tagged failure: every caller treats "not
 * a PR URL" as a routine outcome (skip the durable link, keep the free-text
 * event) rather than as something to report.
 */
export const parsePullRequestUrl = (input: string): ParsedPullRequestUrl | null => {
	const trimmed = input.trim()
	if (trimmed.length === 0) return null

	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return null
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
	const host = parsed.hostname.toLowerCase()
	if (host !== "github.com" && host !== "www.github.com") return null

	const match = GITHUB_PR_PATH.exec(parsed.pathname)
	if (match === null) return null
	const [, owner, repo, rawNumber] = match
	if (owner === undefined || repo === undefined || rawNumber === undefined) return null

	const number = Number.parseInt(rawNumber, 10)
	// A PR number of zero is not a thing, and `Number.parseInt` on a long digit
	// run silently loses precision — both mean this is not a link worth storing.
	if (!Number.isSafeInteger(number) || number <= 0) return null

	// `.git` suffixes turn up when a URL is derived from a clone remote.
	const cleanRepo = repo.endsWith(".git") ? repo.slice(0, -4) : repo
	if (cleanRepo.length === 0) return null

	return {
		provider: "github",
		owner,
		repo: cleanRepo,
		repoFullName: `${owner}/${cleanRepo}`,
		number,
		url: `https://github.com/${owner}/${cleanRepo}/pull/${number}`,
	}
}

/**
 * Maple issue ids referenced in a pull request's title or body.
 *
 * Two forms are recognised and nothing looser. `Fixes #123`, the convention
 * everyone reaches for first, is deliberately NOT one of them: Maple issue ids
 * are UUIDs, so a bare integer can only ever refer to the host provider's own
 * issue tracker, and matching it would link a Maple issue to whatever GitHub
 * issue happened to share the number.
 *
 * `appBaseUrl` is compared by origin, so a deployment reachable under more than
 * one path prefix still matches, and a link to a *different* Maple deployment
 * does not.
 */
export const extractIssueIdsFromText = (text: string, appBaseUrl: string): ReadonlyArray<string> => {
	const found = new Set<string>()

	const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

	// Form 1: a link to the issue in this deployment's dashboard. This is what
	// `issueLinkUrl` emits in every notification and what the issue page's
	// copy-link control puts on the clipboard, so it is the form that actually
	// shows up in PR bodies.
	let origin: string | null = null
	try {
		origin = new URL(appBaseUrl).origin.toLowerCase()
	} catch {
		origin = null
	}
	if (origin !== null) {
		const urlPattern = new RegExp(`https?://[^\\s<>"')\\]]*/errors/issues/(${uuid})`, "gi")
		for (const match of text.matchAll(urlPattern)) {
			const whole = match[0]
			const id = match[1]
			if (id === undefined) continue
			try {
				if (new URL(whole).origin.toLowerCase() !== origin) continue
			} catch {
				continue
			}
			found.add(id.toLowerCase())
		}
	}

	// Form 2: an explicit token, for anyone writing the reference by hand or
	// working against a deployment whose base URL they do not know.
	const tokenPattern = new RegExp(`maple-issue:(${uuid})`, "gi")
	for (const match of text.matchAll(tokenPattern)) {
		const id = match[1]
		if (id !== undefined) found.add(id.toLowerCase())
	}

	return Array.from(found)
}
