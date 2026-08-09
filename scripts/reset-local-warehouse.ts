#!/usr/bin/env bun
/**
 * Truncate every datasource in the LOCAL Tinybird (tinybird-local on :7181) so
 * the warehouse starts empty — replayed fixtures, self-observability noise and
 * derived MV state all gone. Live services immediately begin refilling it.
 *
 *   bun run warehouse:reset              # truncate everything
 *   bun run warehouse:reset -- --traces  # only traces/logs + span-derived tables
 *
 * Refuses to run against anything but localhost, so a cloud TINYBIRD_TOKEN in
 * the environment can never make this destructive beyond the local container.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

const HOST = process.env.TINYBIRD_LOCAL_URL?.replace(/\/+$/u, "") || "http://localhost:7181"

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(HOST)) {
	console.error(`refusing to truncate non-local Tinybird host: ${HOST}`)
	process.exit(1)
}

/** Kept when --traces is passed: everything not derived from spans or logs. */
const NON_TRACE_PREFIXES = ["metrics_", "metric_catalog", "session_", "alert_checks", "service_usage"]

function readToken(): string {
	if (process.env.TINYBIRD_TOKEN?.trim()) return process.env.TINYBIRD_TOKEN.trim()
	try {
		const env = readFileSync(join(import.meta.dir, "..", ".env.local"), "utf8")
		const match = env.match(/^TINYBIRD_TOKEN=(?:"([^"]*)"|(\S+))$/mu)
		const token = match?.[1] ?? match?.[2]
		if (token) return token
	} catch {
		// fall through to the error below
	}
	console.error("TINYBIRD_TOKEN not set and not found in .env.local")
	process.exit(1)
}

const token = readToken()
const tracesOnly = process.argv.includes("--traces")

const listRes = await fetch(`${HOST}/v0/datasources`, {
	headers: { Authorization: `Bearer ${token}` },
})
if (!listRes.ok) {
	console.error(`listing datasources failed: HTTP ${listRes.status} ${await listRes.text()}`)
	process.exit(1)
}
const { datasources } = (await listRes.json()) as {
	datasources: Array<{ name: string; statistics?: { row_count?: number } }>
}

let failed = 0
for (const ds of datasources) {
	if (tracesOnly && NON_TRACE_PREFIXES.some((p) => ds.name.startsWith(p))) {
		console.log(`  keep     ${ds.name}`)
		continue
	}
	const res = await fetch(`${HOST}/v0/datasources/${ds.name}/truncate`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	})
	// Tinybird answers 205 Reset Content on success.
	if (res.ok || res.status === 205) {
		console.log(`  truncate ${ds.name} (${ds.statistics?.row_count ?? "?"} rows)`)
	} else {
		failed++
		console.error(`  FAILED   ${ds.name}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
	}
}

console.log(failed > 0 ? `done with ${failed} failure(s)` : "done — local warehouse is empty")
process.exit(failed > 0 ? 1 : 0)
