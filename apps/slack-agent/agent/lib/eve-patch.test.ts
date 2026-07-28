import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { resolveSlackBotToken } from "eve/channels/slack"

/**
 * Canary for `patches/eve@0.25.3.patch` — the multi-workspace patch that
 * threads `{ teamId, channelId, threadTs }` into eve's `botToken` credential
 * (upstream vercel/eve#222 leaves it arg-less).
 *
 * This is the failure mode worth catching: the patch does not break loudly
 * when it stops applying. Without it, `resolveBotToken` is called with no
 * context, `context.teamId` is undefined, the per-team lookup is skipped, and
 * every workspace's outbound calls fall through to whatever `SLACK_BOT_TOKEN`
 * happens to be set — failing OPEN onto the wrong credential rather than
 * erroring. The pinned `"eve": "0.25.3"` (exact, not caret) is what keeps a
 * lockfile refresh from dropping the patch; these tests prove the pin held AND
 * that the patched code path is the one actually loaded.
 */

const require_ = createRequire(import.meta.url)

describe("eve multi-workspace patch", () => {
	test("the installed eve is the exact version the patch targets", () => {
		const appPkg = JSON.parse(
			readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
		) as {
			dependencies: Record<string, string>
			patchedDependencies: Record<string, string>
		}
		const installedVersion = (
			JSON.parse(readFileSync(require_.resolve("eve/package.json"), "utf8")) as {
				version: string
			}
		).version

		// Exact pin: a range here is what lets the patch silently fall off.
		expect(appPkg.dependencies.eve).toBe(installedVersion)
		expect(
			Object.keys(appPkg.patchedDependencies),
			"patchedDependencies must name the installed eve version",
		).toContain(`eve@${installedVersion}`)
	})

	test("resolveSlackBotToken passes the request context to the credential", async () => {
		// The patch rewrites eve's built JS, not its .d.ts, so the published type
		// still advertises the unpatched arity — hence the cast. That mismatch is
		// exactly why this has to be asserted at runtime.
		const patched = resolveSlackBotToken as unknown as (
			credential: (context: unknown) => Promise<string>,
			context: unknown,
		) => Promise<string>

		const seen: unknown[] = []
		const token = await patched(
			async (context: unknown) => {
				seen.push(context)
				return "xoxb-per-team"
			},
			{ teamId: "T1", channelId: "C1", threadTs: "1700000000.000100" },
		)

		expect(token).toBe("xoxb-per-team")
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ teamId: "T1", channelId: "C1" })
	})
})

describe("eve __maple_ui strip patch", () => {
	/**
	 * Canary for the second half of `patches/eve@0.25.3.patch`: connection tool
	 * results pass through `McpConnectionClient.executeTool`, where the patch
	 * drops content entries tagged `__maple_ui`. Those entries are the structured
	 * payloads Maple's MCP server emits for the web chat's tables/charts
	 * (`createDualContent` in apps/api); chat-flue splits them out client-side
	 * (`splitToolResult` in apps/chat-flue/src/lib/mcp.ts), and without this
	 * patch the Slack agent's model receives the raw JSON blob duplicated next
	 * to the text report on every Maple tool call.
	 *
	 * Like the botToken patch, this fails SILENTLY when it stops applying — the
	 * blob just comes back — so the test loads the patched module and exercises
	 * the actual strip function the patch exports.
	 */
	const require_ = createRequire(import.meta.url)
	const eveRoot = new URL(".", `file://${require_.resolve("eve/package.json")}`).href

	test("executeTool's strip helper drops __maple_ui entries and nothing else", async () => {
		const module_ = (await import(`${eveRoot}dist/src/runtime/connections/mcp-client.js`)) as {
			stripMapleUiContent?: (result: unknown) => unknown
		}
		const strip = module_.stripMapleUiContent
		expect(strip, "patch dropped: mcp-client.js no longer exports stripMapleUiContent").toBeDefined()

		const uiEntry = {
			type: "text",
			text: JSON.stringify({ __maple_ui: true, kind: "table", rows: [[1, 2]] }),
		}
		const report = { type: "text", text: "3 services, 2 unhealthy" }
		const stripped = strip!({ content: [report, uiEntry], isError: false }) as {
			content: unknown[]
			isError: boolean
		}
		expect(stripped.content).toEqual([report])
		expect(stripped.isError).toBe(false)

		// Ordinary results — including JSON text that merely mentions the marker
		// as a string — pass through untouched (same object, no copy).
		const mention = { type: "text", text: `The marker is "__maple_ui" in source` }
		const plain = { content: [report, mention] }
		expect(strip!(plain)).toBe(plain)
		expect(strip!("plain string result")).toBe("plain string result")
		expect(strip!(null)).toBe(null)
	})
})
