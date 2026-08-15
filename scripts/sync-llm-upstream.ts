/**
 * Sync (or verify) the vendored `lib/llm` against its upstream, `anomalyco/opencode`.
 *
 *   bun run llm:sync                  # re-vendor src/ at the SHA pinned in UPSTREAM.json
 *   bun run llm:sync --sha=<sha>      # re-vendor at a new SHA and rewrite UPSTREAM.json
 *   bun run llm:sync --check          # CI: fail if vendored src/ drifted from upstream
 *                                     #     outside the documented delta (see MAPLE.md)
 *
 * `test/` is deliberately out of scope — it was ported from `bun:test` to vitest and from
 * `@opencode-ai/http-recorder` to a local replay layer, so it no longer tracks upstream.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Schema from "effect/Schema"

const packageDir = fileURLToPath(new URL("../lib/llm", import.meta.url))
const upstreamPath = join(packageDir, "UPSTREAM.json")

/** Files under `src/` that Maple intentionally diverges on. Keep in sync with `MAPLE.md`. */
const KNOWN_DELTAS = new Set(["src/schema/ids.ts", "src/schema/messages.ts"])
/** Files under `src/` that Maple adds and upstream does not have. */
const MAPLE_ONLY = new Set(["src/schema/opencode-llm.ts"])

const Upstream = Schema.Struct({
	repo: Schema.String,
	ref: Schema.String,
	sha: Schema.String,
	path: Schema.String,
	license: Schema.String,
	syncedAt: Schema.String,
})

const args = process.argv.slice(2)
const checkMode = args.includes("--check")
const shaArg = args.find((arg) => arg.startsWith("--sha="))?.slice("--sha=".length)

const upstream = Schema.decodeUnknownSync(Schema.fromJsonString(Upstream))(readFileSync(upstreamPath, "utf8"))
const sha = shaArg ?? upstream.sha

if (!/^[0-9a-f]{40}$/.test(sha)) {
	console.error(`Refusing to sync against a non-SHA ref: ${sha}. Upstream is unpublished — pin a SHA.`)
	process.exit(1)
}

const git = (cwd: string, ...gitArgs: ReadonlyArray<string>) =>
	execFileSync("git", [...gitArgs], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

const listFiles = (root: string, prefix = ""): ReadonlyArray<string> =>
	readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
		return entry.isDirectory() ? listFiles(root, rel) : [rel]
	})

const checkout = mkdtempSync(join(tmpdir(), "maple-llm-sync-"))
try {
	git(checkout, "init", "--quiet")
	git(checkout, "remote", "add", "origin", upstream.repo)
	git(checkout, "config", "core.sparseCheckout", "true")
	git(checkout, "sparse-checkout", "init", "--cone")
	git(checkout, "sparse-checkout", "set", upstream.path)
	git(checkout, "fetch", "--quiet", "--depth", "1", "origin", sha)
	git(checkout, "checkout", "--quiet", "FETCH_HEAD")

	const upstreamSrc = join(checkout, upstream.path, "src")
	const localSrc = join(packageDir, "src")

	const upstreamFiles = new Set(listFiles(upstreamSrc))
	const localFiles = new Set(listFiles(localSrc))

	const changed: Array<string> = []
	const added: Array<string> = []
	const removed: Array<string> = []

	for (const file of upstreamFiles) {
		const rel = `src/${file}`
		if (!localFiles.has(file)) {
			removed.push(rel)
			continue
		}
		const upstreamContent = readFileSync(join(upstreamSrc, file), "utf8")
		const localContent = readFileSync(join(localSrc, file), "utf8")
		if (upstreamContent !== localContent) changed.push(rel)
	}
	for (const file of localFiles) {
		if (!upstreamFiles.has(file)) added.push(`src/${file}`)
	}

	if (checkMode) {
		const unexpectedChanged = changed.filter((file) => !KNOWN_DELTAS.has(file))
		const unexpectedAdded = added.filter((file) => !MAPLE_ONLY.has(file))
		const problems = [
			...unexpectedChanged.map((file) => `  modified locally: ${file}`),
			...unexpectedAdded.map((file) => `  added locally:    ${file}`),
			...removed.map((file) => `  missing locally:  ${file}`),
		]
		if (problems.length > 0) {
			console.error(`lib/llm has drifted from upstream ${sha.slice(0, 12)}:`)
			console.error(problems.join("\n"))
			console.error(
				"\nEither re-sync with `bun run llm:sync`, or record the delta in lib/llm/MAPLE.md " +
					"and in KNOWN_DELTAS/MAPLE_ONLY in scripts/sync-llm-upstream.ts.",
			)
			process.exit(1)
		}
		console.log(
			`lib/llm matches upstream ${sha.slice(0, 12)} ` +
				`(${upstreamFiles.size} files, ${changed.length} documented deltas).`,
		)
	} else {
		for (const file of upstreamFiles) {
			const target = join(localSrc, file)
			if (KNOWN_DELTAS.has(`src/${file}`)) continue
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, readFileSync(join(upstreamSrc, file)))
		}
		for (const file of localFiles) {
			if (upstreamFiles.has(file) || MAPLE_ONLY.has(`src/${file}`)) continue
			rmSync(join(localSrc, file))
		}
		const next: Upstream = { ...upstream, sha, syncedAt: new Date().toISOString().slice(0, 10) }
		writeFileSync(upstreamPath, `${JSON.stringify(next, null, "\t")}\n`)

		console.log(`Synced lib/llm/src from ${upstream.repo}@${sha.slice(0, 12)}.`)
		console.log(`  ${upstreamFiles.size} upstream files`)
		if (changed.length > 0) console.log(`  changed: ${changed.join(", ")}`)
		if (removed.length > 0) console.log(`  removed: ${removed.join(", ")}`)
		console.log(
			`  skipped (documented deltas): ${[...KNOWN_DELTAS].join(", ")} — ` +
				"re-apply the schema import rewrite by hand if upstream touched them.",
		)
		console.log("\nReview `git diff lib/llm` and update lib/llm/MAPLE.md.")
	}
} finally {
	rmSync(checkout, { recursive: true, force: true })
}
