// Self-update for the `maple` binary. Two entry points:
//   • `maybeNotifyUpdate` — a throttled, non-blocking startup check (run from
//     bin.ts) that prints a one-line "update available" notice on stderr.
//   • `performUpdate` — downloads the latest (or pinned) GitHub release bundle,
//     verifies its sha256, and atomically swaps the running binary in place
//     (driven by `maple update`, see commands/update.ts).
//
// We mirror scripts/install.sh's conventions (target triples, release URLs,
// 2-file bundle, checksum, macOS quarantine clear) rather than shelling out to
// it: the installer uses `cp`, which fails with ETXTBSY when overwriting the
// *running* executable on Linux. Self-update instead downloads into a temp dir
// on the same filesystem as the install dir and `rename()`s over the targets —
// rename swaps the directory entry, so the running process keeps its old inode
// while new invocations pick up the new binary. Keep the triple/URL logic here
// in sync with install.sh.
import { Clock, Effect, Option, Schema } from "effect"
import { realpathSync } from "node:fs"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { amber, bold, dim, green } from "../lib/style"
import { MAPLE_VERSION } from "../version"
import { MapleConfig } from "./config"

/** A `maple update` / version-check failure. The message is shown to the user
 *  and the process exits non-zero (handled by the CLI runtime, like ServerError). */
export class UpdateError extends Schema.TaggedErrorClass<UpdateError>()("@maple/cli/UpdateError", {
	message: Schema.String,
}) {}

const REPO = "Makisuo/maple"
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
/** Throttle window for the startup check — hit GitHub at most once per day. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000

// --- pure helpers (unit-tested) ----------------------------------------------

/** Drop a leading "v" so release tags ("v0.6.0") compare against MAPLE_VERSION
 *  ("0.6.0", already stripped in version.ts). */
export const stripV = (v: string): string => v.replace(/^v/, "")

/** Map a Node platform/arch pair to a release target triple, or null when no
 *  bundle is published for it. Mirrors scripts/install.sh's case statement. */
export const targetTripleFor = (platform: string, arch: string): string | null => {
	if (platform === "darwin") {
		if (arch === "arm64") return "aarch64-apple-darwin"
		if (arch === "x64") return "x86_64-apple-darwin"
		return null
	}
	if (platform === "linux") {
		if (arch === "x64") return "x86_64-unknown-linux-gnu"
		if (arch === "arm64") return "aarch64-unknown-linux-gnu"
		return null
	}
	return null
}

/** Numeric semver-ish compare: is `latest` newer than `current`? Compares
 *  major.minor.patch only (pre-release/build suffixes ignored). Returns false
 *  for dev builds or unparseable versions so we never nag spuriously. */
export const isNewer = (current: string, latest: string): boolean => {
	if (current === "dev") return false
	const parse = (v: string): number[] =>
		stripV(v)
			.split(/[.\-+]/)
			.slice(0, 3)
			.map((n) => Number.parseInt(n, 10))
	const c = parse(current)
	const l = parse(latest)
	if (c.some(Number.isNaN) || l.some(Number.isNaN)) return false
	for (let i = 0; i < 3; i++) {
		const cv = c[i] ?? 0
		const lv = l[i] ?? 0
		if (lv > cv) return true
		if (lv < cv) return false
	}
	return false
}

/** Throttle decision: should we hit the network this run? True when we've never
 *  checked, the stored timestamp is unparseable, or it's older than `ttlMs`. */
export const shouldCheck = (
	lastCheckIso: string | undefined,
	nowMs: number,
	ttlMs: number = CHECK_TTL_MS,
): boolean => {
	if (!lastCheckIso) return true
	const last = Date.parse(lastCheckIso)
	if (Number.isNaN(last)) return true
	return nowMs - last >= ttlMs
}

// --- IO ----------------------------------------------------------------------

const resolveTarget: Effect.Effect<string, UpdateError> = Effect.suspend(() => {
	const t = targetTripleFor(process.platform, process.arch)
	return t
		? Effect.succeed(t)
		: Effect.fail(
				new UpdateError({
					message: `unsupported platform ${process.platform}/${process.arch} — Maple ships macOS and Linux (x64/arm64) builds`,
				}),
			)
})

/** Fetch the latest release tag from the GitHub API (keeps the leading "v" for
 *  URL building). Bounded by `timeoutMs` via AbortController. */
export const fetchLatestTag = (timeoutMs = 5000): Effect.Effect<string, UpdateError> =>
	Effect.tryPromise({
		try: async () => {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), timeoutMs)
			try {
				// GitHub rejects requests without a User-Agent; Accept pins the API version.
				const res = await fetch(LATEST_API, {
					headers: { "User-Agent": "maple-cli", Accept: "application/vnd.github+json" },
					signal: controller.signal,
				})
				if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText}`)
				const body = (await res.json()) as { tag_name?: string }
				if (!body.tag_name) throw new Error("no published release found")
				return body.tag_name
			} finally {
				clearTimeout(timer)
			}
		},
		catch: (e) =>
			new UpdateError({
				message: `could not check for updates: ${e instanceof Error ? e.message : String(e)}`,
			}),
	})

/** Directory holding the running `maple` binary and its sibling `libchdb.so`
 *  (the symlink on PATH resolves here). */
const resolveInstallDir = (): string => dirname(realpathSync(process.execPath))

const mapFsError = (e: unknown, installDir: string): UpdateError => {
	const code = (e as { code?: string } | null)?.code
	if (code === "EACCES" || code === "EPERM") {
		return new UpdateError({
			message: `cannot write to ${installDir} — re-run the installer (curl -fsSL https://maple.dev/cli/install | sh) or fix permissions`,
		})
	}
	return new UpdateError({ message: e instanceof Error ? e.message : String(e) })
}

const downloadTo = (url: string, dest: string): Effect.Effect<void, UpdateError> =>
	Effect.tryPromise({
		try: async () => {
			const res = await fetch(url, { headers: { "User-Agent": "maple-cli" } })
			if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText}) for ${url}`)
			// NB: `Bun.write(dest, res)` (writing the Response directly) hangs
			// indefinitely on GitHub's redirect-backed release-asset streams — it
			// never resolves. Buffer the body first, then write the bytes.
			const body = await res.arrayBuffer()
			await Bun.write(dest, body)
		},
		catch: (e) => new UpdateError({ message: e instanceof Error ? e.message : String(e) }),
	})

const fetchText = (url: string): Effect.Effect<string, UpdateError> =>
	Effect.tryPromise({
		try: async () => {
			const res = await fetch(url, { headers: { "User-Agent": "maple-cli" } })
			if (!res.ok) throw new Error(`could not fetch ${url} (${res.status} ${res.statusText})`)
			return await res.text()
		},
		catch: (e) => new UpdateError({ message: e instanceof Error ? e.message : String(e) }),
	})

const sha256File = (path: string): Effect.Effect<string, UpdateError> =>
	Effect.tryPromise({
		try: async () => {
			const hasher = new Bun.CryptoHasher("sha256")
			for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
			return hasher.digest("hex")
		},
		catch: (e) =>
			new UpdateError({
				message: `could not hash bundle: ${e instanceof Error ? e.message : String(e)}`,
			}),
	})

const extractTar = (tarball: string, destDir: string): Effect.Effect<void, UpdateError> =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn(["tar", "-xzf", tarball, "-C", destDir], {
				stdout: "ignore",
				stderr: "pipe",
			})
			const code = await proc.exited
			if (code !== 0) {
				const err = await new Response(proc.stderr).text()
				throw new Error(`tar exited ${code}: ${err.trim()}`)
			}
		},
		catch: (e) =>
			new UpdateError({
				message: `could not extract bundle: ${e instanceof Error ? e.message : String(e)}`,
			}),
	})

/** Best-effort: strip the Gatekeeper quarantine flag macOS sets on downloads. */
const clearQuarantine = (paths: ReadonlyArray<string>): Effect.Effect<void> =>
	Effect.promise(async () => {
		try {
			await Bun.spawn(["xattr", "-dr", "com.apple.quarantine", ...paths], {
				stdout: "ignore",
				stderr: "ignore",
			}).exited
		} catch {
			// best effort — quarantine clearing failing shouldn't fail the update
		}
	})

export interface UpdateResult {
	readonly tag: string
	readonly installDir: string
}

/** Download, verify, and atomically install a release bundle in place. */
export const performUpdate = (opts: { tag?: string } = {}): Effect.Effect<UpdateResult, UpdateError> =>
	Effect.gen(function* () {
		const target = yield* resolveTarget
		const tagRaw = opts.tag ?? (yield* fetchLatestTag(10_000))
		const tag = tagRaw.startsWith("v") ? tagRaw : `v${tagRaw}`
		const installDir = yield* Effect.try({
			try: () => resolveInstallDir(),
			catch: (e) => new UpdateError({ message: `could not resolve install directory: ${String(e)}` }),
		})

		const name = `maple-${tag}-${target}`
		const url = `https://github.com/${REPO}/releases/download/${tag}/${name}.tar.gz`
		// Temp dir lives *inside* installDir so the final rename is same-filesystem
		// (atomic; cross-device rename would EXDEV).
		const tmpDir = join(installDir, ".maple-update-tmp")

		yield* Effect.scoped(
			Effect.gen(function* () {
				yield* Effect.addFinalizer(() =>
					Effect.promise(() => rm(tmpDir, { recursive: true, force: true }).catch(() => {})),
				)

				// Fresh temp dir.
				yield* Effect.tryPromise({
					try: async () => {
						await rm(tmpDir, { recursive: true, force: true })
						await mkdir(tmpDir, { recursive: true })
					},
					catch: (e) => mapFsError(e, installDir),
				})

				const tarball = join(tmpDir, "bundle.tar.gz")
				yield* downloadTo(url, tarball)

				const expected = yield* fetchText(`${url}.sha256`).pipe(
					Effect.map((t) => t.trim().split(/\s+/)[0]),
				)
				const actual = yield* sha256File(tarball)
				if (expected !== actual) {
					return yield* new UpdateError({
						message: `checksum mismatch for ${name} (expected ${expected}, got ${actual})`,
					})
				}

				yield* extractTar(tarball, tmpDir)
				const srcDir = join(tmpDir, name)

				// Atomic in-place swap of both bundle files.
				yield* Effect.tryPromise({
					try: async () => {
						await rename(join(srcDir, "maple"), join(installDir, "maple"))
						await rename(join(srcDir, "libchdb.so"), join(installDir, "libchdb.so"))
						await chmod(join(installDir, "maple"), 0o755)
					},
					catch: (e) => mapFsError(e, installDir),
				})

				if (process.platform === "darwin") {
					yield* clearQuarantine([join(installDir, "maple"), join(installDir, "libchdb.so")])
				}
			}),
		)

		return { tag, installDir }
	})

// --- startup notice ----------------------------------------------------------

const NOTIFY_SKIP_FLAGS = new Set(["--version", "-v", "--help", "-h"])

/** Whether the throttled startup check should run at all. Skips dev builds, the
 *  opt-out env var, non-TTY (CI/pipes), and the update/version/help paths. */
const shouldRunNotify = (argv: ReadonlyArray<string>): boolean => {
	if (MAPLE_VERSION === "dev") return false
	if (process.env.MAPLE_NO_UPDATE_CHECK) return false
	if (process.stderr.isTTY !== true) return false
	const args = argv.slice(2)
	if (args[0] === "update") return false
	if (args.some((a) => NOTIFY_SKIP_FLAGS.has(a))) return false
	return true
}

const printNotice = (current: string, latest: string): void => {
	process.stderr.write(
		`\n${amber("●")} ${bold("update available")} ${dim(current)} ${dim("→")} ${green(latest)}\n` +
			`  ${dim("run")} ${bold("maple update")} ${dim("to upgrade")}\n\n`,
	)
}

/**
 * Throttled startup version check. Reads the cached `lastUpdateCheck`; if it's
 * stale (>24h) it fetches the latest tag (short timeout) and records the result,
 * otherwise it decides purely from the cached `latestKnownVersion`. Prints a
 * notice to stderr when a newer release exists. Never blocks fatally and never
 * fails the command — every error path collapses to a no-op.
 */
export const maybeNotifyUpdate: Effect.Effect<void, never, MapleConfig> = Effect.gen(function* () {
	if (!shouldRunNotify(process.argv)) return
	const config = yield* MapleConfig
	const now = yield* Clock.currentTimeMillis
	let latest = config.latestKnownVersion

	if (shouldCheck(config.lastUpdateCheck, now)) {
		const fetched = yield* fetchLatestTag(1500).pipe(
			Effect.map((tag) => Option.some(tag)),
			Effect.catch(() => Effect.succeed(Option.none<string>())),
		)
		if (Option.isSome(fetched)) {
			latest = fetched.value
			yield* config.recordUpdateCheck(fetched.value).pipe(Effect.ignore)
		} else {
			// Record the timestamp even on failure so an offline machine backs off
			// for the TTL instead of re-probing GitHub on every command.
			yield* config.recordUpdateCheck().pipe(Effect.ignore)
		}
	}

	if (latest && isNewer(MAPLE_VERSION, latest)) {
		yield* Effect.sync(() => printNotice(MAPLE_VERSION, stripV(latest)))
	}
})
