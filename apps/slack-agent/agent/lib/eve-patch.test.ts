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
