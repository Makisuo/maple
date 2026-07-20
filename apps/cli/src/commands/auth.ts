import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import { MapleConfig } from "../core/config"
import { Mode } from "../core/mode"
import { printJson } from "../lib/output"

/** Read a single line from stdin (used for the token when `--token` is omitted). */
const readStdinLine = Effect.tryPromise(
	() =>
		new Promise<string>((resolve) => {
			let data = ""
			const onData = (chunk: string) => {
				data += chunk
				const nl = data.indexOf("\n")
				if (nl >= 0) {
					cleanup()
					resolve(data.slice(0, nl))
				}
			}
			const onEnd = () => {
				cleanup()
				resolve(data)
			}
			const cleanup = () => {
				process.stdin.off("data", onData)
				process.stdin.off("end", onEnd)
				try {
					process.stdin.pause()
				} catch {
					/* ignore */
				}
			}
			process.stdin.setEncoding("utf8")
			process.stdin.on("data", onData)
			process.stdin.on("end", onEnd)
			try {
				process.stdin.resume()
			} catch {
				/* ignore */
			}
		}),
).pipe(Effect.orElseSucceed(() => ""))

export const login = Command.make("login", {
	apiUrl: Flag.optional(
		Flag.string("api-url").pipe(Flag.withDescription("Maple API base URL (e.g. https://api.maple.dev)")),
	),
	token: Flag.optional(
		Flag.string("token").pipe(
			Flag.withDescription(
				"API token. If omitted, it is read from stdin (so it stays out of shell history).",
			),
		),
	),
}).pipe(
	Command.withDescription("Save remote workspace credentials to ~/.maple/config.json"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const config = yield* MapleConfig
			const apiUrl = Option.getOrElse(a.apiUrl, () => config.defaultApiUrl)

			let token = Option.getOrUndefined(a.token)
			if (!token) {
				yield* Console.error(`Paste the API token for ${apiUrl} and press Enter:`)
				token = (yield* readStdinLine).trim()
			}
			if (!token) {
				yield* Console.error("No token provided — nothing was saved.")
				return
			}

			yield* config.write({ apiUrl, token })
			yield* Console.log(
				`Logged in to ${apiUrl}. Credentials saved to ~/.maple/config.json (0600). ` +
					"Commands auto-detect remote now; pin it with `maple use remote`, or use --local / `maple start` for local mode.",
			)
		}),
	),
)

export const logout = Command.make("logout", {}).pipe(
	Command.withDescription("Remove the stored remote token from ~/.maple/config.json"),
	Command.withHandler(
		Effect.fnUntraced(function* () {
			const config = yield* MapleConfig
			yield* config.clearToken()
			yield* Console.log("Logged out — removed the stored token.")
		}),
	),
)

export const whoami = Command.make("whoami", {}).pipe(
	Command.withDescription("Show the resolved mode (local/remote) and target"),
	Command.withHandler(
		Effect.fnUntraced(function* () {
			const config = yield* MapleConfig
			const mode = yield* Mode
			const defaultMode = Option.getOrElse(config.defaultMode, () => "auto" as const)
			const resolved = yield* mode.resolve.pipe(
				Effect.map((m) => ({ ok: true as const, m })),
				Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
			)
			if (!resolved.ok) {
				yield* printJson({ mode: "none", defaultMode, message: resolved.message })
				return
			}
			yield* printJson(
				resolved.m._tag === "local"
					? { mode: "local", defaultMode, url: resolved.m.baseUrl }
					: {
							mode: "remote",
							defaultMode,
							apiUrl: resolved.m.apiUrl,
							orgId: resolved.m.orgId ?? null,
						},
			)
		}),
	),
)
