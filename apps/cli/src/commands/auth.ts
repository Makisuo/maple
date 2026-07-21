import * as os from "node:os"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Duration, Effect, Option, Redacted, Schema } from "effect"
import { MapleConfig } from "../core/config"
import { deleteNativeCredential } from "../core/credential-store"
import { Mode } from "../core/mode"
import { printJson } from "../lib/output"

class CliAuthError extends Schema.TaggedErrorClass<CliAuthError>()("@maple/cli/CliAuthError", {
	message: Schema.String,
}) {}

type Session = { readonly orgId: string; readonly userId: string; readonly roles?: ReadonlyArray<string> }
type DeviceStart = {
	readonly deviceCode: string
	readonly userCode: string
	readonly verificationUri: string
	readonly verificationUriComplete: string
	readonly expiresIn: number
	readonly interval: number
}
type DevicePoll =
	| { readonly status: "pending"; readonly interval: number }
	| { readonly status: "complete"; readonly token: string; readonly orgId: string; readonly userId: string }
	| { readonly status: "denied" }
	| { readonly status: "expired" }

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
				process.stdin.pause()
			}
			process.stdin.setEncoding("utf8")
			process.stdin.on("data", onData)
			process.stdin.on("end", onEnd)
			process.stdin.resume()
		}),
).pipe(Effect.orElseSucceed(() => ""))

const normalizeApiUrl = (value: string) =>
	Effect.try({
		try: () => {
			const url = new URL(value)
			if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol")
			return url.origin
		},
		catch: () => new CliAuthError({ message: `Invalid Maple API URL: ${value}` }),
	})

const requestJson = <A>(url: string, init?: RequestInit): Effect.Effect<A, CliAuthError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url, init)
			const body = (await response.json().catch(() => null)) as ({ message?: unknown } & A) | null
			if (!response.ok) {
				throw new Error(
					typeof body?.message === "string"
						? body.message
						: `Maple API returned HTTP ${response.status}`,
				)
			}
			if (body === null) throw new Error("Maple API returned an empty response")
			return body
		},
		catch: (error) =>
			new CliAuthError({
				message: error instanceof Error ? error.message : "Maple API request failed",
			}),
	})

const validateToken = (apiUrl: string, token: string): Effect.Effect<Session, CliAuthError> =>
	requestJson<Session>(`${apiUrl}/api/auth/session`, {
		headers: { authorization: `Bearer ${token}` },
	}).pipe(
		Effect.flatMap((session) =>
			typeof session.orgId === "string" && typeof session.userId === "string"
				? Effect.succeed(session)
				: Effect.fail(new CliAuthError({ message: "Maple returned an invalid session response" })),
		),
	)

const revokeManagedToken = (apiUrl: string, token: string) =>
	requestJson(`${apiUrl}/api/auth/cli/session`, {
		method: "DELETE",
		headers: { authorization: `Bearer ${token}` },
	}).pipe(Effect.asVoid)

const openBrowser = (url: string) =>
	Effect.tryPromise({
		try: async () => {
			const command = process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
			const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
			if ((await child.exited) !== 0) throw new Error("browser launcher exited unsuccessfully")
		},
		catch: () => new CliAuthError({ message: "Could not open a browser" }),
	})

const saveCredential = (apiUrl: string, token: string, session: Session, managed: boolean) =>
	Effect.gen(function* () {
		const config = yield* MapleConfig
		const previousApiUrl = Option.getOrUndefined(config.apiUrl)
		const previousToken = Option.map(config.token, Redacted.value).pipe(Option.getOrUndefined)
		const previousManaged = config.credentialManaged
		const store = yield* config.saveRemoteCredential({
			apiUrl,
			token,
			orgId: session.orgId,
			userId: session.userId,
			managed,
		})
		if (store === "file") {
			yield* Console.error(
				"Warning: no native credential store was available; the token was saved to ~/.maple/config.json (0600).",
			)
		}
		if (previousToken && previousApiUrl && previousManaged && previousToken !== token) {
			yield* revokeManagedToken(previousApiUrl, previousToken).pipe(Effect.ignore)
		}
		if (previousApiUrl && previousApiUrl !== apiUrl) {
			yield* Effect.promise(() => deleteNativeCredential(previousApiUrl))
		}
		return store
	})

const loginFlags = {
	apiUrl: Flag.optional(
		Flag.string("api-url").pipe(
			Flag.withDescription("Maple API base URL (default: https://api.maple.dev)"),
		),
	),
	withToken: Flag.boolean("with-token").pipe(
		Flag.withDescription("Read an existing API token from standard input instead of opening a browser"),
		Flag.withDefault(false),
	),
}

const loginHandler = Effect.fnUntraced(function* (a: {
	readonly apiUrl: Option.Option<string>
	readonly withToken: boolean
}) {
	const config = yield* MapleConfig
	if (config.envTokenOverride) {
		return yield* new CliAuthError({
			message:
				"MAPLE_API_TOKEN is set and overrides stored credentials. Unset it before running maple auth login.",
		})
	}
	const apiUrl = yield* normalizeApiUrl(Option.getOrElse(a.apiUrl, () => config.defaultApiUrl))

	if (a.withToken) {
		const token = (yield* readStdinLine).trim()
		if (!token) return yield* new CliAuthError({ message: "No token was provided on standard input" })
		const session = yield* validateToken(apiUrl, token)
		const store = yield* saveCredential(apiUrl, token, session, false)
		yield* Console.log(`✓ Logged in to ${apiUrl} as ${session.userId} (${session.orgId}) via ${store}.`)
		return
	}

	const started = yield* requestJson<DeviceStart>(`${apiUrl}/api/auth/cli/device`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ deviceName: `Maple CLI on ${os.hostname()}` }),
	})
	yield* Console.error(`! First copy your one-time code: ${started.userCode}`)
	yield* Console.error(`  ${started.verificationUri}`)
	if (process.stdin.isTTY && process.stdout.isTTY) {
		yield* Console.error("Press Enter to open Maple in your browser…")
		yield* readStdinLine
		yield* openBrowser(started.verificationUriComplete).pipe(
			Effect.catchTag("@maple/cli/CliAuthError", () =>
				Console.error(`Could not open a browser. Visit ${started.verificationUriComplete}`),
			),
		)
	} else {
		yield* Console.error(`Open ${started.verificationUriComplete} to continue.`)
	}

	const deadline = Date.now() + started.expiresIn * 1000
	let interval = Math.max(1, started.interval)
	while (Date.now() < deadline) {
		yield* Effect.sleep(Duration.seconds(interval))
		const result = yield* requestJson<DevicePoll>(`${apiUrl}/api/auth/cli/device/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		}).pipe(Effect.option)
		if (Option.isNone(result)) continue
		if (result.value.status === "pending") {
			interval = Math.max(interval, result.value.interval)
			continue
		}
		if (result.value.status === "denied") {
			return yield* new CliAuthError({ message: "CLI login was denied in the browser" })
		}
		if (result.value.status === "expired") {
			return yield* new CliAuthError({ message: "CLI login code expired; run maple auth login again" })
		}
		const session = yield* validateToken(apiUrl, result.value.token)
		const store = yield* saveCredential(apiUrl, result.value.token, session, true)
		yield* Console.log(`✓ Logged in to ${apiUrl} as ${session.userId} (${session.orgId}) via ${store}.`)
		return
	}
	return yield* new CliAuthError({ message: "CLI login code expired; run maple auth login again" })
})

const makeLogin = (name: string) =>
	Command.make(name, loginFlags).pipe(
		Command.withDescription("Authenticate to a Maple workspace in your browser"),
		Command.withHandler(loginHandler),
	)

const statusHandler = Effect.fnUntraced(function* () {
	const config = yield* MapleConfig
	const apiUrl = Option.getOrUndefined(config.apiUrl)
	const token = Option.map(config.token, Redacted.value).pipe(Option.getOrUndefined)
	if (!apiUrl || !token) {
		process.exitCode = 1
		yield* Console.error("Not logged in. Run `maple auth login`.")
		return
	}
	const session = yield* validateToken(apiUrl, token).pipe(Effect.option)
	if (Option.isNone(session)) {
		process.exitCode = 1
		yield* Console.error(`Authentication to ${apiUrl} is invalid or expired.`)
		return
	}
	yield* Console.log(`✓ Logged in to ${apiUrl}`)
	yield* Console.log(`  User: ${session.value.userId}`)
	yield* Console.log(`  Workspace: ${session.value.orgId}`)
	yield* Console.log(`  Credential: ${config.tokenSource}`)
})

const makeStatus = (name: string) =>
	Command.make(name, {}).pipe(
		Command.withDescription("Show and validate the active Maple login"),
		Command.withHandler(statusHandler),
	)

const logoutHandler = Effect.fnUntraced(function* () {
	const config = yield* MapleConfig
	if (config.envTokenOverride) {
		return yield* new CliAuthError({
			message: "MAPLE_API_TOKEN is set and cannot be removed by Maple. Unset it to log out.",
		})
	}
	const apiUrl = Option.getOrUndefined(config.apiUrl)
	const token = Option.map(config.token, Redacted.value).pipe(Option.getOrUndefined)
	if (apiUrl && token && config.credentialManaged) {
		yield* revokeManagedToken(apiUrl, token).pipe(
			Effect.catchTag("@maple/cli/CliAuthError", (error) =>
				Console.error(`Warning: could not revoke the remote credential: ${error.message}`),
			),
		)
	}
	yield* config.clearRemoteCredential()
	yield* Console.log("✓ Logged out and removed the stored credential.")
})

const makeLogout = (name: string) =>
	Command.make(name, {}).pipe(
		Command.withDescription("Revoke and remove the active Maple login"),
		Command.withHandler(logoutHandler),
	)

export const login = makeLogin("login")
export const logout = makeLogout("logout")
const authLogin = makeLogin("login")
const authStatus = makeStatus("status")
const authLogout = makeLogout("logout")

export const auth = Command.make("auth").pipe(
	Command.withDescription("Manage Maple authentication"),
	Command.withSubcommands([authLogin, authStatus, authLogout]),
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
				Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
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
