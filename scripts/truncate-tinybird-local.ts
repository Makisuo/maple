#!/usr/bin/env bun
/**
 * Truncate every datasource in the local Tinybird workspace — a clean slate for
 * re-seeding during UI development.
 *
 *   bun run tinybird:truncate            # all datasources
 *   bun run tinybird:truncate traces     # just these, by name
 *
 * Reads TINYBIRD_HOST / TINYBIRD_TOKEN from the environment (.env.local at the
 * repo root — bun loads it automatically). The datasource list comes from the
 * workspace itself, so new datasources never need adding here.
 *
 * Refuses non-localhost hosts: .env.local sometimes points at a cloud
 * workspace (PR-branch and staging token swaps), and this command must never
 * be one stale env file away from emptying it. --force overrides.
 */

const args = process.argv.slice(2)
const force = args.includes("--force")
const only = new Set(args.filter((a) => !a.startsWith("--")))

const host = (process.env.TINYBIRD_HOST ?? "http://localhost:7181").replace(/\/+$/, "")
const token = process.env.TINYBIRD_TOKEN
if (!token) {
	console.error("TINYBIRD_TOKEN is not set — is .env.local present at the repo root?")
	process.exit(1)
}

const hostname = new URL(host).hostname
const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")
if (!isLocal && !force) {
	console.error(`refusing to truncate non-local Tinybird at ${host} (pass --force if you really mean it)`)
	process.exit(1)
}

const authed = { headers: { Authorization: `Bearer ${token}` } }
const list = await fetch(`${host}/v0/datasources`, authed)
if (!list.ok) {
	console.error(`GET /v0/datasources failed: ${list.status} ${await list.text()}`)
	process.exit(1)
}
const { datasources } = (await list.json()) as { datasources: Array<{ name: string }> }

const targets = datasources.map((d) => d.name).filter((name) => only.size === 0 || only.has(name))
const unknown = [...only].filter((name) => !targets.includes(name))
if (unknown.length > 0) {
	console.error(`no such datasource: ${unknown.join(", ")}`)
	process.exit(1)
}
if (targets.length === 0) {
	console.log("no datasources to truncate")
	process.exit(0)
}

let failed = false
for (const name of targets) {
	const res = await fetch(`${host}/v0/datasources/${name}/truncate`, { method: "POST", ...authed })
	if (res.ok) {
		console.log(`truncated ${name}`)
	} else {
		failed = true
		console.error(`truncate ${name} failed: ${res.status} ${await res.text()}`)
	}
}
process.exit(failed ? 1 : 0)
