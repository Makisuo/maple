#!/usr/bin/env bun
/**
 * Verify the Bento credentials before any code path depends on them.
 *
 *   infisical run --env=prod --silent -- bun run bento:check
 *   infisical run --env=prod --silent -- bun run bento:check --write
 *
 * Reads BENTO_SITE_UUID / BENTO_PUBLISHABLE_KEY / BENTO_SECRET_KEY from the
 * environment. Prefer `infisical run` over copying them into .env.local — the
 * Bento keys live in the `prod` Infisical environment only, and this keeps them
 * off disk. `--env` is required: .infisical.json sets no default environment.
 *
 * The default run is a GET against `/fetch/tags`, which cannot create a
 * subscriber, record an event, or send mail — it only proves that the Basic
 * credential pair, the site UUID and the User-Agent header are accepted.
 *
 * `--write` exercises `POST /batch/subscribers`, which Bento documents as NOT
 * triggering Flows or Automations. It creates one real subscriber on the site
 * (delete it afterwards). It still cannot send mail, and `/batch/events` — the
 * only endpoint that can — is deliberately not reachable from this script.
 */

const SITE_UUID = process.env.BENTO_SITE_UUID?.trim()
const PUBLISHABLE_KEY = process.env.BENTO_PUBLISHABLE_KEY?.trim()
const SECRET_KEY = process.env.BENTO_SECRET_KEY?.trim()
const API_BASE = (process.env.BENTO_API_BASE_URL?.trim() || "https://app.bentonow.com/api/v1").replace(
	/\/$/,
	"",
)

const missing = [
	["BENTO_SITE_UUID", SITE_UUID],
	["BENTO_PUBLISHABLE_KEY", PUBLISHABLE_KEY],
	["BENTO_SECRET_KEY", SECRET_KEY],
].filter(([, value]) => !value)

if (missing.length > 0 || !SITE_UUID || !PUBLISHABLE_KEY || !SECRET_KEY) {
	console.error(`Missing: ${missing.map(([key]) => key).join(", ")}`)
	console.error("Add them to .env.local (or export them) and re-run.")
	process.exit(1)
}

// Same construction as BentoService: Basic publishable:secret, site_uuid as a
// query param, and a User-Agent (Cloudflare blocks Bento requests without one).
const authorization = `Basic ${Buffer.from(`${PUBLISHABLE_KEY}:${SECRET_KEY}`).toString("base64")}`
const headers = {
	Authorization: authorization,
	Accept: "application/json",
	"User-Agent": "maple-api",
	"Content-Type": "application/json",
}

const describe = (status: number) => {
	if (status === 401 || status === 403) return "credentials rejected — wrong key pair, or keys from a different site"
	if (status === 404) return "not found — check BENTO_SITE_UUID belongs to this key pair"
	return `unexpected status ${status}`
}

const url = `${API_BASE}/fetch/tags?site_uuid=${encodeURIComponent(SITE_UUID)}`
const response = await fetch(url, { headers })

if (!response.ok) {
	console.error(`✗ GET /fetch/tags → ${response.status}: ${describe(response.status)}`)
	console.error((await response.text()).slice(0, 400))
	process.exit(1)
}

console.log(`✓ credentials accepted (GET /fetch/tags → ${response.status})`)
console.log(`  site_uuid ...${SITE_UUID.slice(-6)} · ${API_BASE}`)

if (!process.argv.includes("--write")) {
	console.log("\nRead-only check passed. Re-run with --write to also test a subscriber upsert.")
	process.exit(0)
}

const testEmail = `maple-bento-check+${Date.now()}@example.com`
const writeResponse = await fetch(`${API_BASE}/batch/subscribers?site_uuid=${encodeURIComponent(SITE_UUID)}`, {
	method: "POST",
	headers,
	body: JSON.stringify({
		subscribers: [{ email: testEmail, maple_cohort: "legacy", maple_source: "bento-check" }],
	}),
})

const writeBody = await writeResponse.text()
if (!writeResponse.ok) {
	console.error(`✗ POST /batch/subscribers → ${writeResponse.status}: ${describe(writeResponse.status)}`)
	console.error(writeBody.slice(0, 400))
	process.exit(1)
}

console.log(`✓ subscriber upsert accepted → ${writeBody.trim()}`)
console.log(`  created ${testEmail} with maple_cohort=legacy — delete it in the Bento UI.`)
console.log("  Bento processes batch imports within ~5 minutes, so it may not appear instantly.")
