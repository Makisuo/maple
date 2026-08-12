/**
 * Self-host Miniflare runtime for the Maple worker triad.
 *
 * Hosts api, alerting, and electric-sync in one Miniflare process. Each
 * worker's bindings and cron schedules are derived from its own
 * `wrangler.jsonc` at boot (see `readWrangler`/`toWorkerOptions`), so this
 * runtime tracks upstream config changes with no manual mirroring. The
 * control-plane database is Postgres (MAPLE_PG_URL), reached through the
 * Hyperdrive binding each worker already declares and migrated here on boot
 * with drizzle. KV, the SQLite-backed Durable Object, and queue/workflow
 * state persist under MAPLE_DATA_DIR (default `/data`).
 *
 * Exposed:
 *   - API_PORT (3472) — api worker (Miniflare's primary entrypoint)
 *   - ELECTRIC_SYNC_PORT (3476) — electric-sync worker, proxied via Node http
 *
 * Crons fire via the worker proxies' Fetcher RPC `scheduled()`, passing the
 * exact cron expression each handler dispatches on.
 *
 * Bindings intentionally dropped from the wrangler configs (Cloudflare-only
 * services with documented fallbacks):
 *   - `ai` (Workers AI) — the LLM layer falls back to OpenRouter over REST;
 *     set OPENROUTER_API_KEY to enable chat + AI triage.
 *   - `send_email` (EMAIL) — sends skip when the binding is missing.
 */

import { CronJob } from "cron"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { Log, LogLevel, Miniflare, type WorkerOptions } from "miniflare"
import postgres from "postgres"

const DATA_DIR = process.env.MAPLE_DATA_DIR ?? "/data"
const API_PORT = Number(process.env.API_PORT ?? 3472)
const ELECTRIC_SYNC_PORT = Number(process.env.ELECTRIC_SYNC_PORT ?? 3476)
const BUNDLES_DIR = process.env.MAPLE_BUNDLES_DIR ?? "/app/bundles"
const WRANGLER_DIR = process.env.MAPLE_WRANGLER_DIR ?? "/app/wrangler"
const MIGRATIONS_DIR = process.env.MAPLE_MIGRATIONS_DIR ?? "/app/migrations"

// Which worker owns the HTTP entry vs. the side-proxied worker vs. cron-only.
const PRIMARY_WORKER = "api"
const PROXIED_WORKER = "electric-sync"
const WORKER_NAMES = [PRIMARY_WORKER, "alerting", PROXIED_WORKER] as const

const PG_URL = process.env.MAPLE_PG_URL
if (!PG_URL) throw new Error("MAPLE_PG_URL is required (postgres:// control-plane database URL)")

// --- wrangler.jsonc → Miniflare WorkerOptions -------------------------------

interface WranglerConfig {
	compatibility_date?: string
	compatibility_flags?: string[]
	vars?: Record<string, string>
	hyperdrive?: Array<{ binding: string }>
	kv_namespaces?: Array<{ binding: string }>
	durable_objects?: { bindings?: Array<{ name: string; class_name: string }> }
	migrations?: Array<{ new_sqlite_classes?: string[] }>
	workflows?: Array<{ name: string; binding: string; class_name: string }>
	queues?: {
		producers?: Array<{ binding: string; queue: string }>
		consumers?: Array<{
			queue: string
			max_batch_size?: number
			max_batch_timeout?: number
			max_retries?: number
		}>
	}
	ratelimits?: Array<{
		name: string
		namespace_id: string
		simple: { limit: number; period?: number }
	}>
	triggers?: { crons?: string[] }
}

const readWrangler = (name: string): WranglerConfig =>
	parseJsonc(readFileSync(join(WRANGLER_DIR, `${name}.jsonc`), "utf8")) as WranglerConfig

const findBundle = (name: string): string => join(BUNDLES_DIR, name, "worker.js")

const toWorkerOptions = (
	name: string,
	cfg: WranglerConfig,
	sharedBindings: Record<string, string>,
): WorkerOptions => {
	const opts: Record<string, unknown> = {
		name,
		modules: [{ type: "ESModule", path: findBundle(name) }],
		compatibilityDate: cfg.compatibility_date,
		compatibilityFlags: cfg.compatibility_flags,
		// wrangler `vars` are plain strings; fold them in with the shared env.
		bindings: { ...sharedBindings, ...(cfg.vars ?? {}) },
	}

	// Every declared Hyperdrive points at the one control-plane Postgres.
	if (cfg.hyperdrive?.length) {
		opts.hyperdrives = Object.fromEntries(cfg.hyperdrive.map((h) => [h.binding, PG_URL]))
	}
	if (cfg.kv_namespaces?.length) {
		opts.kvNamespaces = Object.fromEntries(cfg.kv_namespaces.map((k) => [k.binding, k.binding]))
	}
	if (cfg.durable_objects?.bindings?.length) {
		const sqliteClasses = new Set(
			(cfg.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []),
		)
		opts.durableObjects = Object.fromEntries(
			cfg.durable_objects.bindings.map((d) => [
				d.name,
				{ className: d.class_name, useSQLite: sqliteClasses.has(d.class_name) },
			]),
		)
	}
	if (cfg.workflows?.length) {
		opts.workflows = Object.fromEntries(
			cfg.workflows.map((w) => [w.binding, { name: w.name, className: w.class_name }]),
		)
	}
	if (cfg.queues?.producers?.length) {
		opts.queueProducers = Object.fromEntries(
			cfg.queues.producers.map((p) => [p.binding, p.queue]),
		)
	}
	if (cfg.queues?.consumers?.length) {
		opts.queueConsumers = Object.fromEntries(
			cfg.queues.consumers.map((c) => [
				c.queue,
				{
					maxBatchSize: c.max_batch_size,
					maxBatchTimeout: c.max_batch_timeout,
					maxRetries: c.max_retries,
				},
			]),
		)
	}
	if (cfg.ratelimits?.length) {
		opts.ratelimits = Object.fromEntries(
			cfg.ratelimits.map((r) => [r.name, { namespace_id: r.namespace_id, simple: r.simple }]),
		)
	}

	return opts as WorkerOptions
}

// --- boot -------------------------------------------------------------------

const configs = new Map(WORKER_NAMES.map((name) => [name, readWrangler(name)]))

// Drizzle migrations against Postgres, before any worker starts. Idempotent —
// tracked in __drizzle_migrations. Retry while Postgres finishes booting.
{
	const sql = postgres(PG_URL, { max: 1, fetch_types: false })
	const db = drizzle(sql)
	console.log("[migrate] applying drizzle migrations…")
	let lastError: unknown
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
			lastError = undefined
			break
		} catch (err) {
			lastError = err
			console.warn(`[migrate] attempt ${attempt}/10 failed: ${(err as Error).message}`)
			await new Promise((r) => setTimeout(r, 3000))
		}
	}
	await sql.end()
	if (lastError) throw lastError
	console.log("[migrate] complete")
}

// Forward Maple-relevant env vars to all workers as bindings.
const envPrefixRe =
	/^(MAPLE_|CLICKHOUSE_|TINYBIRD_|CLERK_|RESEND_|AUTUMN_|SD_|INTERNAL_|ELECTRIC_|OPENROUTER_)/
const sharedBindings: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
	if (v !== undefined && envPrefixRe.test(k)) sharedBindings[k] = v
}

const mf = new Miniflare({
	log: new Log(LogLevel.INFO),
	host: "0.0.0.0",
	port: API_PORT,

	// Single root for KV / DO / queue / workflow state (Miniflare 5 replaced
	// the per-plugin *Persist options with this).
	resourcePersistencePath: DATA_DIR,

	// The primary worker must be first so it owns the HTTP entry on API_PORT.
	workers: WORKER_NAMES.map((name) => toWorkerOptions(name, configs.get(name)!, sharedBindings)),
})

await mf.ready
console.log(`[runtime] api listening on :${API_PORT}`)

// electric-sync proxy on its own port — Miniflare only exposes the first worker.
const electricSync = await mf.getWorker(PROXIED_WORKER)

const proxyToWorker = async (
	worker: { fetch: (input: string, init: RequestInit) => Promise<Response> },
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> => {
	try {
		const proto = (req.headers["x-forwarded-proto"] as string) ?? "http"
		const host = (req.headers["x-forwarded-host"] as string) ?? (req.headers.host ?? "localhost")
		const url = `${proto}://${host}${req.url ?? "/"}`

		let body: Buffer | undefined
		if (req.method && req.method !== "GET" && req.method !== "HEAD") {
			const chunks: Buffer[] = []
			for await (const chunk of req) chunks.push(chunk as Buffer)
			body = Buffer.concat(chunks)
		}

		const upstream = await worker.fetch(url, {
			method: req.method,
			headers: req.headers as Record<string, string>,
			body,
		})
		res.statusCode = upstream.status
		upstream.headers.forEach((value, key) => res.setHeader(key, value))
		if (upstream.body) {
			const reader = upstream.body.getReader()
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				res.write(Buffer.from(value))
			}
		}
		res.end()
	} catch (err) {
		console.error("[proxy] error:", err)
		res.statusCode = 502
		res.end(`bad gateway: ${(err as Error).message}`)
	}
}

createServer((req, res) => {
	proxyToWorker(electricSync as never, req, res).catch((err) => {
		console.error("[proxy] unhandled:", err)
		if (!res.headersSent) res.statusCode = 500
		res.end()
	})
}).listen(ELECTRIC_SYNC_PORT, "0.0.0.0", () => {
	console.log(`[runtime] ${PROXIED_WORKER} listening on :${ELECTRIC_SYNC_PORT}`)
})

// Cron triggers. The worker proxy's Fetcher RPC `scheduled()` runs the worker's
// scheduled handler; each handler dispatches on the exact cron expression, so
// it is passed through verbatim. Schedules come from each worker's wrangler.jsonc.
type ScheduledWorker = { scheduled: (opts: { cron?: string }) => Promise<{ outcome: string }> }

const triggerCron = async (
	workerName: string,
	worker: ScheduledWorker,
	cron: string,
): Promise<void> => {
	try {
		const result = await worker.scheduled({ cron })
		if (result.outcome !== "ok") console.error(`[cron] ${workerName} ${cron} → ${result.outcome}`)
	} catch (err) {
		console.error(`[cron] ${workerName} ${cron} failed:`, err)
	}
}

for (const name of WORKER_NAMES) {
	const crons = configs.get(name)?.triggers?.crons ?? []
	if (crons.length === 0) continue
	const worker = (await mf.getWorker(name)) as unknown as ScheduledWorker
	for (const cron of crons) {
		new CronJob(cron, () => triggerCron(name, worker, cron), null, true)
	}
	console.log(`[runtime] ${name} crons registered: ${crons.join(", ")}`)
}

// Cleanup
const shutdown = async (signal: string): Promise<void> => {
	console.log(`[runtime] received ${signal}, shutting down`)
	await mf.dispose()
	process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
