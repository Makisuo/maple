/**
 * Shared plumbing for the `.md` twins.
 *
 * Every HTML page worth citing has a markdown sibling at the same path plus a
 * `.md` suffix (`/pricing` → `/pricing.md`), indexed by `/llms.txt`. Answer
 * engines get a table instead of a `font-mono tabular-nums` div grid, and
 * `public/robots.txt` already opts every one of them in by name.
 *
 * These routes are **English-only and un-prefixed**. Paraglide resolves a
 * message against an AsyncLocalStorage the astro integration sets up around a
 * *page* render; an endpoint route runs outside it and resolves to the source
 * locale. That is the behaviour we want here — `page-registry.ts` documents the
 * same resolution as a hazard for `getStaticPaths`, so don't "fix" it.
 */

const MARKDOWN_TYPE = "text/markdown; charset=utf-8"
const TEXT_TYPE = "text/plain; charset=utf-8"

/** A `.md` twin. One trailing newline, like a file on disk. */
export const markdown = (body: string): Response =>
	new Response(`${body.trimEnd()}\n`, { headers: { "Content-Type": MARKDOWN_TYPE } })

/** `llms.txt` and friends — markdown-shaped, but `text/plain` by convention. */
export const plainText = (body: string): Response =>
	new Response(`${body.trimEnd()}\n`, { headers: { "Content-Type": TEXT_TYPE } })

/**
 * Joins blocks with exactly one blank line between them, dropping empties so a
 * conditional section can just evaluate to `""` at the call site.
 */
export const blocks = (...parts: (string | false | null | undefined)[]): string =>
	parts
		.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
		.map((p) => p.trim())
		.join("\n\n")

/**
 * The header every twin opens with, so a standalone `.md` reads on its own.
 * No YAML frontmatter — Resend ships none, and it only invites parsers to choke.
 */
export const docHeader = (title: string, description?: string): string => blocks(`# ${title}`, description)

/** A GitHub-flavoured table. Cells are emitted verbatim; escape pipes yourself. */
export const table = (headers: string[], rows: string[][]): string =>
	[
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n")

/** `- [label](url)` */
export const link = (label: string, url: string): string => `[${label}](${url})`

/** Absolute URL against the configured `site` — feeds `llms.txt`, same as rss.xml.ts. */
export const absolute = (site: URL | undefined, path: string): string =>
	new URL(path, site ?? "https://maple.dev").toString()

/** Cell-safe: a literal `|` would open a new column. */
export const cell = (value: string): string => value.replace(/\|/g, "\\|")
