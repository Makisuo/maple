const REPO = "Makisuo/maple"

let cached: Promise<number | null> | undefined

/**
 * Fetches the repo's stargazer count once per build, memoized.
 *
 * Nav/Footer render on every page and DocsLayout on every docs page, so the
 * module-level cache is what keeps a full static build to a single API call —
 * without it a large build could blow GitHub's 60/hr unauthenticated limit.
 *
 * Any failure (non-OK response, network error, unexpected shape) resolves to
 * `null` so the build never breaks and callers simply omit the count.
 */
export function getGitHubStars(): Promise<number | null> {
	if (!cached) {
		cached = fetchStars()
	}
	return cached
}

async function fetchStars(): Promise<number | null> {
	try {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
		}
		const token = import.meta.env.GITHUB_TOKEN
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}

		const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers })
		if (!res.ok) return null

		const data = (await res.json()) as { stargazers_count?: unknown }
		return typeof data.stargazers_count === "number" ? data.stargazers_count : null
	} catch {
		return null
	}
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** Formats a star count compactly, e.g. 1234 → "1.2K". */
export function formatStars(count: number): string {
	return compact.format(count)
}
