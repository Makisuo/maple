#!/usr/bin/env bun
/**
 * Push dummy OTLP traces + logs to the local ingest gateway for UI development.
 *
 *   bun scripts/ingest-dummy.ts [options]
 *   bun run ingest:dummy -- [options]
 *
 * This is a dev-only convenience: it hand-rolls OTLP/JSON and POSTs it straight at
 * the Rust ingest gateway (https://ingest.localhost → http://localhost:3474), the
 * same path real telemetry takes. The gateway stamps every span/log with your org
 * (MAPLE_ORG_ID_OVERRIDE in single-tenant mode), so the data shows up for the
 * test user at https://web.localhost. No metrics / dashboards — traces + logs only.
 *
 * The headline use case is the commit-SHA UI: each generated trace carries a
 * `deployment.commit_sha` *resource* attribute, which the `service_overview_spans`
 * materialized view extracts into the `CommitSha` column (per service, per deploy).
 * Pass real 40-char SHAs (`--shas`) — or let it pull recent ones from `git log` —
 * so the hover card can resolve them to actual commit messages via the GitHub app.
 *
 * Examples:
 *   # The "improve the commit-SHAs UI" scenario: 3 SHAs 10 min apart, each with a
 *   # varying number of traces, anchored at now.
 *   bun scripts/ingest-dummy.ts \
 *     --shas ea0466fa99642d7633860b2079debf30562a58a0,a24daf481e65f0c333073b5bf8a39583a972910d,d9f88a8518437a85ac88d4a36bf55e72962e7365 \
 *     --sha-interval 10m --traces-per-sha 3-9 --service checkout-api
 *
 *   # No SHAs given → use the 3 most recent commits from `git log`:
 *   bun scripts/ingest-dummy.ts --num-shas 3 --sha-interval 10m
 *
 *   # Inspect the payload without sending anything:
 *   bun scripts/ingest-dummy.ts --traces-per-sha 2 --dry-run
 *
 * Wire format (verified against opentelemetry-proto 0.31 `with-serde`, the crate
 * the gateway decodes JSON with): camelCase keys, trace/span ids are lowercase
 * hex strings, *UnixNano fields are decimal-nanosecond *strings*, structs carry
 * `#[serde(default)]` so omitted fields (e.g. a root span's parentSpanId) are fine.
 */
import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"

const FAILURE = 1

// ── OTLP enums ──────────────────────────────────────────────────────────────
const SPAN_KIND_INTERNAL = 1
const SPAN_KIND_SERVER = 2
const SPAN_KIND_CLIENT = 3
// Successful spans are left UNSET (0), never OK: per the OTel spec, instrumentation
// only ever sets Error, and Ok is reserved for an explicit application override — so
// essentially no real Maple span arrives as Ok and fixture data must not either.
const STATUS_UNSET = 0
const STATUS_ERROR = 2
const SEVERITY_INFO = 9
const SEVERITY_WARN = 13
const SEVERITY_ERROR = 17

// ── defaults ────────────────────────────────────────────────────────────────
// Hit the raw gateway port over plain HTTP by default: portless terminates TLS at
// https://ingest.localhost and proxies to :3474, but Bun's fetch would reject the
// portless self-signed cert. :3474 sidesteps that. Override with --endpoint.
const DEFAULT_ENDPOINT = process.env.MAPLE_INGEST_URL?.trim() || "http://localhost:3474"
// Any maple_pk_*/maple_sk_* string resolves to MAPLE_ORG_ID_OVERRIDE in single-tenant dev.
const DEFAULT_KEY = process.env.MAPLE_INGEST_KEY?.trim() || "maple_pk_local"
const DEFAULT_SERVICE = "checkout-api"
const DEFAULT_ENV = "production"
const MAX_SPANS_PER_REQUEST = 3000 // keep bodies well under INGEST_MAX_REQUEST_BODY_BYTES (20 MB)

const HEX40 = /^[0-9a-f]{40}$/

interface Range {
	readonly min: number
	readonly max: number
}

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

// ── tiny seeded RNG (mulberry32) for reproducible *shape* (counts/latencies/etc).
// Span & trace ids always use crypto randomness so they stay globally unique. ──
let rngState = 0
const seedRng = (seed: number): void => {
	rngState = seed >>> 0
}
const rng = (): number => {
	rngState |= 0
	rngState = (rngState + 0x6d2b79f5) | 0
	let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const randInt = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))
const randIn = (r: Range): number => randInt(r.min, r.max)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T
const chance = (p: number): boolean => rng() < p

// ── parsing helpers ─────────────────────────────────────────────────────────
const parseRange = (raw: string, label: string): Range => {
	const m = raw.match(/^(\d+)(?:-(\d+))?$/)
	if (!m) fail(`${label}: expected N or MIN-MAX, got "${raw}"`)
	const min = Number(m![1])
	const max = m![2] === undefined ? min : Number(m![2])
	if (max < min) fail(`${label}: min (${min}) > max (${max})`)
	return { min, max }
}

const parseDurationMs = (raw: string, label: string): number => {
	const m = raw.match(/^(\d+)(ms|s|m|h)?$/)
	if (!m) fail(`${label}: expected a duration like 30s/10m/2h, got "${raw}"`)
	const n = Number(m![1])
	switch (m![2]) {
		case "h":
			return n * 3_600_000
		case "m":
			return n * 60_000
		case "s":
			return n * 1000
		default:
			return n // bare number = ms
	}
}

// ── encoding helpers ────────────────────────────────────────────────────────
const traceId = (): string => randomBytes(16).toString("hex")
const spanId = (): string => randomBytes(8).toString("hex")
const nano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString()
const attr = (key: string, value: string | number): Record<string, unknown> =>
	typeof value === "number"
		? { key, value: { intValue: String(value) } }
		: { key, value: { stringValue: value } }

// ── realistic-ish content ───────────────────────────────────────────────────
const ROUTES: ReadonlyArray<{ method: string; route: string }> = [
	{ method: "GET", route: "/api/checkout" },
	{ method: "POST", route: "/api/orders" },
	{ method: "GET", route: "/api/products" },
	{ method: "POST", route: "/api/payments" },
	{ method: "GET", route: "/api/cart" },
	{ method: "GET", route: "/api/users/{id}" },
]
const DB_CALLS = ["SELECT orders", "INSERT payments", "UPDATE inventory", "SELECT users"]
const CLIENT_CALLS = ["GET payments-gateway", "POST email-service", "GET pricing-service"]
const CACHE_CALLS = ["redis GET session", "redis SET cart"]
const EXCEPTIONS: ReadonlyArray<{ type: string; message: string }> = [
	{ type: "TimeoutError", message: "upstream timed out after 5000ms" },
	{ type: "ConnectionResetError", message: "connection reset by peer" },
	{ type: "ValidationError", message: "missing required field: amount" },
	{ type: "PaymentDeclinedError", message: "card declined (insufficient_funds)" },
]

interface Options {
	endpoint: string
	key: string
	service: string
	env: string
	shas: string[]
	shaInterval: number
	tracesPerSha: Range
	children: Range
	logsPerTrace: Range
	errorRate: number
	spread: number
	anchor: number
	dryRun: boolean
	quiet: boolean
}

interface GeneratedSha {
	sha: string
	at: number
	spans: Record<string, unknown>[]
	logs: Record<string, unknown>[]
	traceCount: number
	errorCount: number
}

const recentGitShas = (n: number): string[] => {
	try {
		const out = execFileSync("git", ["log", `-n${n}`, "--pretty=%H"], {
			cwd: new URL("..", import.meta.url).pathname,
			encoding: "utf8",
		})
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}

/** Build all spans + correlated logs for one commit SHA. */
const generateForSha = (sha: string, at: number, opts: Options): GeneratedSha => {
	const spans: Record<string, unknown>[] = []
	const logs: Record<string, unknown>[] = []
	const traceCount = randIn(opts.tracesPerSha)
	let errorCount = 0

	for (let i = 0; i < traceCount; i++) {
		const tid = traceId()
		const rootId = spanId()
		// Scatter this trace within [at - spread, at] so everything stays in the past.
		const startMs = at - Math.floor(rng() * opts.spread)
		const isError = chance(opts.errorRate)
		if (isError) errorCount++

		const { method, route } = pick(ROUTES)
		const baseLatency = randInt(20, 400) + (isError ? randInt(100, 1200) : 0)
		const status = isError ? 500 : 200

		const rootAttrs = [
			attr("http.request.method", method),
			attr("http.route", route),
			attr("url.path", route.replace("{id}", String(randInt(1000, 9999)))),
			attr("http.response.status_code", status),
			attr("server.address", `${opts.service}.internal`),
		]

		const root: Record<string, unknown> = {
			traceId: tid,
			spanId: rootId,
			name: `${method} ${route}`,
			kind: SPAN_KIND_SERVER,
			startTimeUnixNano: nano(startMs),
			endTimeUnixNano: nano(startMs + baseLatency),
			attributes: rootAttrs,
			status: isError
				? { code: STATUS_ERROR, message: "internal server error" }
				: { code: STATUS_UNSET },
		}

		// Child spans, all parented to the root (flat tree — plenty for the UI).
		const childCount = randIn(opts.children)
		const childSpans: Record<string, unknown>[] = []
		for (let c = 0; c < childCount; c++) {
			const childDur = Math.max(1, Math.floor(baseLatency * (0.1 + rng() * 0.6)))
			const childStart = startMs + randInt(0, Math.max(0, baseLatency - childDur))
			// The last child of a failing request is the thing that failed.
			const childErrored = isError && c === childCount - 1

			// Pick a child flavor (weighted), which decides kind + name + attributes.
			let kind: number
			let name: string
			let childAttrs: Record<string, unknown>[]
			switch (pick(["db", "db", "http", "http", "cache", "internal"] as const)) {
				case "db": {
					kind = SPAN_KIND_CLIENT
					name = pick(DB_CALLS)
					childAttrs = [
						attr("db.system", "postgresql"),
						attr("db.statement", `${name} WHERE org_id = $1`),
					]
					break
				}
				case "http": {
					kind = SPAN_KIND_CLIENT
					name = pick(CLIENT_CALLS)
					childAttrs = [
						attr("http.request.method", name.split(" ")[0]!),
						attr("url.full", `https://${name.split(" ")[1]}/v1`),
					]
					break
				}
				case "cache": {
					kind = SPAN_KIND_CLIENT
					name = pick(CACHE_CALLS)
					childAttrs = [attr("db.system", "redis")]
					break
				}
				default: {
					kind = SPAN_KIND_INTERNAL
					name = "validate request"
					childAttrs = [attr("code.function", "validateOrder")]
				}
			}

			childSpans.push({
				traceId: tid,
				spanId: spanId(),
				parentSpanId: rootId,
				name,
				kind,
				startTimeUnixNano: nano(childStart),
				endTimeUnixNano: nano(childStart + childDur),
				attributes: childAttrs,
				status: childErrored ? { code: STATUS_ERROR } : { code: STATUS_UNSET },
			})
		}

		if (isError) {
			const ex = pick(EXCEPTIONS)
			const failing = (childSpans[childSpans.length - 1] ?? root) as Record<string, unknown>
			failing.events = [
				{
					timeUnixNano: nano(startMs + baseLatency - 1),
					name: "exception",
					attributes: [
						attr("exception.type", ex.type),
						attr("exception.message", ex.message),
						attr(
							"exception.stacktrace",
							`${ex.type}: ${ex.message}\n    at handler (${opts.service}.ts:42)`,
						),
					],
				},
			]
		}

		spans.push(root, ...childSpans)

		// Correlated logs for this trace.
		const logCount = randIn(opts.logsPerTrace)
		for (let l = 0; l < logCount; l++) {
			const errLog = isError && l === 0
			logs.push({
				timeUnixNano: nano(startMs + randInt(0, baseLatency)),
				severityNumber: errLog ? SEVERITY_ERROR : chance(0.15) ? SEVERITY_WARN : SEVERITY_INFO,
				severityText: errLog ? "ERROR" : chance(0.15) ? "WARN" : "INFO",
				body: {
					stringValue: errLog
						? `${pick(EXCEPTIONS).type} handling ${method} ${route}`
						: `${method} ${route} -> ${status}`,
				},
				traceId: tid,
				spanId: rootId,
				attributes: [attr("http.route", route)],
			})
		}
	}

	return { sha, at, spans, logs, traceCount, errorCount }
}

const resourceAttrs = (opts: Options, sha: string): Record<string, unknown>[] => [
	attr("service.name", opts.service),
	// Dual-emitted like every real Maple producer: `deployment.environment.name` is
	// the canonical OTel key, `deployment.environment` the legacy one the Tinybird
	// MVs still pre-extract. Emitting only one would hide UI bugs against the other.
	attr("deployment.environment.name", opts.env),
	attr("deployment.environment", opts.env),
	attr("deployment.commit_sha", sha),
]

const chunk = <T>(xs: T[], size: number): T[][] => {
	const out: T[][] = []
	for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
	return out
}

const postOtlp = async (opts: Options, path: string, body: unknown): Promise<void> => {
	let res: Response
	try {
		res = await fetch(`${opts.endpoint}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
			body: JSON.stringify(body),
		})
	} catch (err) {
		fail(
			`could not reach the ingest gateway at ${opts.endpoint}${path}: ${(err as Error).message}\n` +
				`  Is it running? Start the dev stack (\`bun dev\`) and make sure the otel-collector\n` +
				`  is up (it's the gateway's forward target on :4318). Or override with --endpoint.`,
		)
	}
	if (!res!.ok) {
		const text = await res!.text().catch(() => "")
		fail(`ingest gateway returned ${res!.status} ${res!.statusText} for ${path}: ${text.slice(0, 500)}`)
	}
}

const shortSha = (sha: string): string => (HEX40.test(sha) ? sha.slice(0, 7) : sha.slice(0, 10))

const summarize = (generated: GeneratedSha[], opts: Options): void => {
	const totalSpans = generated.reduce((n, g) => n + g.spans.length, 0)
	const totalLogs = generated.reduce((n, g) => n + g.logs.length, 0)
	const totalTraces = generated.reduce((n, g) => n + g.traceCount, 0)
	const totalErrors = generated.reduce((n, g) => n + g.errorCount, 0)

	console.log(`\n  service: ${opts.service}   env: ${opts.env}   endpoint: ${opts.endpoint}`)
	console.log(
		`  ${"commit".padEnd(12)} ${"when".padEnd(20)} ${"traces".padStart(6)} ${"spans".padStart(6)} ${"logs".padStart(5)} ${"err".padStart(4)}`,
	)
	for (const g of generated) {
		console.log(
			`  ${shortSha(g.sha).padEnd(12)} ${new Date(g.at).toISOString().slice(0, 19).replace("T", " ").padEnd(20)} ` +
				`${String(g.traceCount).padStart(6)} ${String(g.spans.length).padStart(6)} ${String(g.logs.length).padStart(5)} ${String(g.errorCount).padStart(4)}`,
		)
	}
	console.log(`  ${"─".repeat(58)}`)
	console.log(
		`  ${"total".padEnd(12)} ${"".padEnd(20)} ${String(totalTraces).padStart(6)} ${String(totalSpans).padStart(6)} ${String(totalLogs).padStart(5)} ${String(totalErrors).padStart(4)}`,
	)
}

const HELP = `
ingest-dummy — push dummy OTLP traces + logs to the local ingest gateway

Usage: bun scripts/ingest-dummy.ts [options]

Target:
  --endpoint <url>        Ingest base URL          (default ${DEFAULT_ENDPOINT})
  --key <ingest-key>      Bearer ingest key        (default ${DEFAULT_KEY})

Shape:
  --service <name>        service.name             (default ${DEFAULT_SERVICE})
  --env <name>            deployment.environment   (default ${DEFAULT_ENV})
  --shas <a,b,c>          commit SHAs (40-hex resolve in the UI). Omit → recent git log.
  --num-shas <n>          how many recent commits to pull when --shas is omitted (default 3)
  --sha-interval <dur>    spacing between consecutive SHAs, s/m/h (default 10m)
  --traces-per-sha <N|A-B>  traces per SHA, fixed or range (default 3-9)
  --children <N|A-B>      child spans per trace    (default 1-3)
  --logs-per-trace <N|A-B>  correlated logs per trace (default 1-2)
  --error-rate <0..1>     fraction of traces that error (default 0.08)
  --spread <dur>          scatter window per SHA, s/m/h (default 90s)
  --anchor <when>         time of the newest SHA: "now" or ISO-8601 (default now)

Control:
  --seed <n>              seed the shape RNG for reproducible counts/latencies
  --dry-run               print the plan + a sample span, send nothing
  --quiet                 only print errors
  -h, --help
`

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			endpoint: { type: "string" },
			key: { type: "string" },
			service: { type: "string" },
			env: { type: "string" },
			shas: { type: "string" },
			"num-shas": { type: "string" },
			"sha-interval": { type: "string" },
			"traces-per-sha": { type: "string" },
			children: { type: "string" },
			"logs-per-trace": { type: "string" },
			"error-rate": { type: "string" },
			spread: { type: "string" },
			anchor: { type: "string" },
			seed: { type: "string" },
			"dry-run": { type: "boolean" },
			quiet: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	})

	if (values.help) {
		console.log(HELP)
		return
	}

	seedRng(values.seed ? Number(values.seed) : randomBytes(4).readUInt32LE() >>> 0)

	const numShas = values["num-shas"] ? Number(values["num-shas"]) : 3
	let shas: string[]
	if (values.shas) {
		shas = values.shas
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	} else {
		shas = recentGitShas(numShas)
		if (shas.length === 0) {
			// No git history reachable — fabricate SHAs (won't resolve to commit messages).
			shas = Array.from({ length: numShas }, () => randomBytes(20).toString("hex"))
			console.warn("⚠ no git log available; using random SHAs (they won't resolve in the hover card)")
		}
	}
	if (shas.length === 0) fail("no commit SHAs to ingest")
	for (const s of shas) {
		if (!HEX40.test(s))
			console.warn(
				`⚠ "${shortSha(s)}" is not a 40-char hex SHA — it'll render as plain text, not a resolvable commit`,
			)
	}

	const anchorRaw = values.anchor?.trim()
	const anchor = !anchorRaw || anchorRaw === "now" ? Date.now() : Date.parse(anchorRaw)
	if (Number.isNaN(anchor))
		fail(`--anchor: could not parse "${anchorRaw}" (use "now" or an ISO-8601 timestamp)`)

	const opts: Options = {
		endpoint: (values.endpoint?.trim() || DEFAULT_ENDPOINT).replace(/\/$/, ""),
		key: values.key?.trim() || DEFAULT_KEY,
		service: values.service?.trim() || DEFAULT_SERVICE,
		env: values.env?.trim() || DEFAULT_ENV,
		shas,
		shaInterval: parseDurationMs(values["sha-interval"] ?? "10m", "--sha-interval"),
		tracesPerSha: parseRange(values["traces-per-sha"] ?? "3-9", "--traces-per-sha"),
		children: parseRange(values.children ?? "1-3", "--children"),
		logsPerTrace: parseRange(values["logs-per-trace"] ?? "1-2", "--logs-per-trace"),
		errorRate: values["error-rate"] ? Number(values["error-rate"]) : 0.08,
		spread: parseDurationMs(values.spread ?? "90s", "--spread"),
		anchor,
		dryRun: Boolean(values["dry-run"]),
		quiet: Boolean(values.quiet),
	}

	// SHA i sits at anchor - (N-1-i)*interval, so the newest SHA lands on the anchor
	// and earlier ones march back in time.
	const generated = opts.shas.map((sha, i) =>
		generateForSha(sha, opts.anchor - (opts.shas.length - 1 - i) * opts.shaInterval, opts),
	)

	if (!opts.quiet) summarize(generated, opts)

	if (opts.dryRun) {
		const sample = generated.find((g) => g.spans.length > 0)
		if (sample) {
			console.log("\n  ── sample resourceSpans (dry-run, nothing sent) ──")
			console.log(
				JSON.stringify(
					{
						resource: { attributes: resourceAttrs(opts, sample.sha) },
						scopeSpans: [{ scope: { name: "ingest-dummy" }, spans: sample.spans.slice(0, 4) }],
					},
					null,
					2,
				)
					.split("\n")
					.map((l) => `  ${l}`)
					.join("\n"),
			)
		}
		console.log("\n  (dry run — re-run without --dry-run to send)\n")
		return
	}

	// Build + send trace requests, chunked by span count to stay under the body cap.
	let traceReqs = 0
	for (const g of generated) {
		if (g.spans.length === 0) continue
		for (const batch of chunk(g.spans, MAX_SPANS_PER_REQUEST)) {
			await postOtlp(opts, "/v1/traces", {
				resourceSpans: [
					{
						resource: { attributes: resourceAttrs(opts, g.sha) },
						scopeSpans: [{ scope: { name: "ingest-dummy" }, spans: batch }],
					},
				],
			})
			traceReqs++
		}
	}

	// Logs: one request carrying all SHAs' resourceLogs (logs are small).
	const resourceLogs = generated
		.filter((g) => g.logs.length > 0)
		.map((g) => ({
			resource: { attributes: resourceAttrs(opts, g.sha) },
			scopeLogs: [{ scope: { name: "ingest-dummy" }, logRecords: g.logs }],
		}))
	if (resourceLogs.length > 0) await postOtlp(opts, "/v1/logs", { resourceLogs })

	if (!opts.quiet) {
		const totalSpans = generated.reduce((n, g) => n + g.spans.length, 0)
		const totalLogs = generated.reduce((n, g) => n + g.logs.length, 0)
		console.log(
			`\n✓ sent ${totalSpans} spans (${traceReqs} request(s)) + ${totalLogs} logs to ${opts.endpoint}`,
		)
		console.log(
			`  View at https://web.localhost → service "${opts.service}" (last ~${Math.ceil((opts.shaInterval * (opts.shas.length - 1) + opts.spread) / 60000)}m).`,
		)
		console.log("  Data lands async via the collector → Tinybird; give it a few seconds to appear.\n")
	}
}

main().catch((err) => fail((err as Error).stack ?? String(err)))
