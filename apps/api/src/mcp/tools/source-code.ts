import { Effect, Schema } from "effect"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { VcsSourceService } from "@/services/vcs/VcsSourceService"
import { optionalNumberParam, optionalStringParam, requiredStringParam, type McpToolRegistrar } from "./types"
import { McpQueryError, validationError } from "./types"

const MAX_SEARCH_RESULTS = 20
const DEFAULT_SEARCH_RESULTS = 10
const MAX_FILE_LINES = 400
const MAX_FILE_CHARS = 40_000

const toSourceError = (operation: string) => (error: { readonly message: string }) =>
	new McpQueryError({ message: error.message, pipeName: operation, cause: error })

const unsafePath = (path: string): boolean =>
	path.startsWith("/") || path.split("/").some((segment) => segment === "..")

export function registerSourceCodeTools(server: McpToolRegistrar) {
	server.tool(
		"list_source_repositories",
		"List source repositories connected to this Maple organization. Use before source investigation when telemetry does not identify an exact vcs.repository.url.full. Returns only repositories the organization's GitHub App installation can access.",
		Schema.Struct({}),
		Effect.fn("McpTool.listSourceRepositories")(function* () {
			const tenant = yield* resolveTenant
			const source = yield* VcsSourceService
			const repositories = yield* source
				.listRepositories(tenant.orgId)
				.pipe(Effect.mapError(toSourceError("list_source_repositories")))
			const lines = [
				`## Connected source repositories (${repositories.length})`,
				...repositories.map(
					(repo) =>
						`- ${repo.fullName} — tracked ref \`${repo.trackedBranch}\`${repo.isArchived ? " (archived)" : ""}`,
				),
			]
			return { content: [{ type: "text" as const, text: lines.join("\n") }] }
		}),
	)

	server.tool(
		"search_source_code",
		"Search code in one connected source repository. Use exact exception text, function/class names, routes, span names, or log fragments from observed telemetry. Call read_source_file on promising paths. The repository must come from telemetry or list_source_repositories.",
		Schema.Struct({
			repository: requiredStringParam("Connected repository in owner/name form"),
			query: requiredStringParam(
				"Plain code or text to search for; do not include repo/org/user qualifiers",
			),
			path: optionalStringParam("Optional repository path to narrow the search"),
			limit: optionalNumberParam(
				`Maximum matches (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS})`,
			),
		}),
		Effect.fn("McpTool.searchSourceCode")(function* ({ repository, query, path, limit }) {
			if (!query.trim() || query.length > 256 || /(?:^|\s)(?:repo|org|user):/i.test(query)) {
				return validationError(
					"query must be 1-256 characters of plain source text without repo:, org:, or user: qualifiers",
				)
			}
			if (path && unsafePath(path)) return validationError("path must be repository-relative")
			const requestedLimit = Math.min(
				MAX_SEARCH_RESULTS,
				Math.max(1, Math.floor(limit ?? DEFAULT_SEARCH_RESULTS)),
			)
			const tenant = yield* resolveTenant
			const source = yield* VcsSourceService
			const matches = yield* source
				.searchCode(tenant.orgId, repository.trim(), query.trim(), {
					...(path ? { path } : {}),
					limit: requestedLimit,
				})
				.pipe(Effect.mapError(toSourceError("search_source_code")))
			const lines = [`## Source search: ${repository}`, `Query: \`${query.trim()}\``, ""]
			if (matches.length === 0) lines.push("No matching source files found.")
			for (const match of matches) {
				lines.push(`### ${match.path}`, `Blob: \`${match.sha}\``, `URL: ${match.htmlUrl}`)
				for (const snippet of match.snippets.slice(0, 2))
					lines.push("```", snippet.slice(0, 2_000), "```")
				lines.push("")
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] }
		}),
	)

	server.tool(
		"read_source_file",
		"Read a bounded line range from a file in one connected repository. For incident causality, pass the exact deployed commit SHA from telemetry as ref when available; otherwise the repository's tracked branch is used and the result is not proof of deployed code.",
		Schema.Struct({
			repository: requiredStringParam("Connected repository in owner/name form"),
			path: requiredStringParam("Repository-relative file path"),
			ref: optionalStringParam("Branch, tag, or preferably the exact deployed commit SHA"),
			start_line: optionalNumberParam("First 1-based line to return (default 1)"),
			end_line: optionalNumberParam(`Last 1-based line to return (max ${MAX_FILE_LINES} lines)`),
		}),
		Effect.fn("McpTool.readSourceFile")(function* ({ repository, path, ref, start_line, end_line }) {
			if (!path.trim() || unsafePath(path.trim()))
				return validationError("path must be repository-relative")
			const start = Math.max(1, Math.floor(start_line ?? 1))
			const requestedEnd = Math.floor(end_line ?? start + MAX_FILE_LINES - 1)
			if (requestedEnd < start)
				return validationError("end_line must be greater than or equal to start_line")
			const end = Math.min(requestedEnd, start + MAX_FILE_LINES - 1)
			const tenant = yield* resolveTenant
			const source = yield* VcsSourceService
			const file = yield* source
				.readFile(tenant.orgId, repository.trim(), path.trim(), ref?.trim() || undefined)
				.pipe(Effect.mapError(toSourceError("read_source_file")))
			if (file.content.includes("\u0000"))
				return validationError("The requested file is binary and cannot be read as source text")
			const allLines = file.content.split("\n")
			const selected = allLines.slice(start - 1, end)
			let rendered = selected.map((line, index) => `${start + index}: ${line}`).join("\n")
			const charTruncated = rendered.length > MAX_FILE_CHARS
			if (charTruncated) rendered = rendered.slice(0, MAX_FILE_CHARS)
			const rangeEnd = Math.min(end, allLines.length)
			const truncated = charTruncated || rangeEnd < allLines.length
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`## ${repository}/${file.path}`,
							`Ref: \`${file.ref}\` · Blob: \`${file.sha}\` · Lines: ${start}-${rangeEnd}/${allLines.length}${truncated ? " · truncated" : ""}`,
							`URL: ${file.htmlUrl}`,
							"```",
							rendered,
							"```",
						].join("\n"),
					},
				],
			}
		}),
	)
}
