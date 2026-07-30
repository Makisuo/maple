#!/usr/bin/env bun
/**
 * Push the rendered onboarding emails into Bento, and read back what is live.
 *
 *   infisical run --env=prod --silent -- bun run bento:templates list
 *   infisical run --env=prod --silent -- bun run bento:templates diff
 *   infisical run --env=prod --silent -- bun run bento:templates push <sequence-id> <slug>...
 *
 * Bento's public API cannot create sequences or workflows — those are built in
 * the dashboard (see docs/onboarding-sequence.md). What it CAN do is create and
 * update the email templates inside an existing sequence, which is everything
 * except the flow skeleton.
 *
 * `diff` is the drift detector: it compares the HTML live in Bento against
 * packages/email/bento-html/, which is the only version-controlled record of
 * what was pushed. Run it on a schedule once the sequence is live.
 *
 * This script never touches /batch/events, so it cannot cause a send.
 */
import { readdir, readFile } from "node:fs/promises"

const SITE_UUID = process.env.BENTO_SITE_UUID?.trim()
const PUBLISHABLE_KEY = process.env.BENTO_PUBLISHABLE_KEY?.trim()
const SECRET_KEY = process.env.BENTO_SECRET_KEY?.trim()
const API_BASE = (process.env.BENTO_API_BASE_URL?.trim() || "https://app.bentonow.com/api/v1").replace(
	/\/$/,
	"",
)

if (!SITE_UUID || !PUBLISHABLE_KEY || !SECRET_KEY) {
	console.error("Missing BENTO_SITE_UUID / BENTO_PUBLISHABLE_KEY / BENTO_SECRET_KEY.")
	console.error("Run under: infisical run --env=prod --silent -- bun run bento:templates <cmd>")
	process.exit(1)
}

const HTML_DIR = new URL("../packages/email/bento-html/", import.meta.url).pathname

/** Subject lines live here rather than in Bento so they are reviewable too. */
const SUBJECTS: Record<string, string> = {
	"01-welcome": "Welcome to Maple",
	"02-connect-app": "Connect your app to Maple",
	"03-stalled": "Need a hand connecting your app?",
	"04-activation": "You're live on Maple",
}

/**
 * Delay between the previous email and this one, in days — mirrors the waits in
 * docs/onboarding-sequence.md. Bento applies these per template within a
 * sequence; the branch conditions are flow-level and stay dashboard-owned.
 */
const DELAY_DAYS: Record<string, number> = {
	"01-welcome": 0,
	"02-connect-app": 1,
	"03-stalled": 2,
	"04-activation": 0,
}

const headers = {
	Authorization: `Basic ${Buffer.from(`${PUBLISHABLE_KEY}:${SECRET_KEY}`).toString("base64")}`,
	Accept: "application/json",
	"User-Agent": "maple-api",
	"Content-Type": "application/json",
}

const withSite = (path: string) => `${API_BASE}${path}?site_uuid=${encodeURIComponent(SITE_UUID)}`

const call = async (method: string, path: string, body?: unknown) => {
	const response = await fetch(withSite(path), {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const text = await response.text()
	if (!response.ok) {
		console.error(`✗ ${method} ${path} → ${response.status}`)
		console.error(text.slice(0, 600))
		process.exit(1)
	}
	return text ? JSON.parse(text) : null
}

const localHtml = async (slug: string) => readFile(`${HTML_DIR}${slug}.html`, "utf8")

const listSlugs = async () =>
	(await readdir(HTML_DIR)).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort()

/** Bento's payloads vary by endpoint; pull the array out wherever it lives. */
const asArray = (payload: unknown): Array<Record<string, unknown>> => {
	if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>
	if (payload && typeof payload === "object") {
		const data = (payload as { data?: unknown }).data
		if (Array.isArray(data)) return data as Array<Record<string, unknown>>
	}
	return []
}

const describe = (item: Record<string, unknown>) => {
	const attributes = (item.attributes ?? item) as Record<string, unknown>
	const name = attributes.name ?? attributes.subject ?? "(unnamed)"
	return `${String(item.id ?? "?").padEnd(38)} ${String(name)}`
}

const command = process.argv[2]

if (command === "list") {
	for (const [label, path] of [
		["workflows", "/fetch/workflows"],
		["sequences", "/fetch/sequences"],
	] as const) {
		const items = asArray(await call("GET", path))
		console.log(`\n${label} (${items.length}):`)
		if (items.length === 0) console.log("  (none)")
		for (const item of items) console.log(`  ${describe(item)}`)
	}
	console.log(`\nLocal templates: ${(await listSlugs()).join(", ")}`)
	process.exit(0)
}

if (command === "diff") {
	// Workflows, not sequences: the onboarding emails are steps inside the two
	// Flows (that is where the branching lives), and `GET /fetch/workflows`
	// returns their attached `email_templates` read-only. Writing them back is
	// not possible — hence paste-once, drift-check-forever.
	const workflows = asArray(await call("GET", "/fetch/workflows"))
	let drifted = 0
	for (const workflow of workflows) {
		const attributes = (workflow.attributes ?? workflow) as Record<string, unknown>
		const templates = asArray(attributes.email_templates ?? attributes.emails)
		if (templates.length === 0) {
			console.log(`· ${String(attributes.name)} — no email steps yet`)
			continue
		}
		for (const template of templates) {
			const templateAttributes = (template.attributes ?? template) as Record<string, unknown>
			const subject = String(templateAttributes.subject ?? "")
			const slug = Object.keys(SUBJECTS).find((key) => SUBJECTS[key] === subject)
			if (!slug) {
				console.log(`? ${subject} — no local template with this subject`)
				drifted++
				continue
			}
			const live = String(templateAttributes.html ?? "")
			const local = await localHtml(slug)
			if (live.trim() === local.trim()) {
				console.log(`✓ ${slug}`)
			} else {
				console.log(`✗ ${slug} — live HTML differs from packages/email/bento-html/${slug}.html`)
				drifted++
			}
		}
	}
	if (drifted > 0) {
		console.error(`\n${drifted} template(s) drifted. Re-run build:onboarding-html, then push.`)
		process.exit(1)
	}
	console.log("\nNo drift.")
	process.exit(0)
}

if (command === "push") {
	const sequenceId = process.argv[3]
	const slugs = process.argv.slice(4)
	if (!sequenceId || slugs.length === 0) {
		console.error("Usage: bento:templates push <sequence-id> <slug>...")
		console.error(`Slugs: ${(await listSlugs()).join(", ")}`)
		process.exit(1)
	}

	for (const slug of slugs) {
		const subject = SUBJECTS[slug]
		if (!subject) {
			console.error(`Unknown slug "${slug}" — no subject line defined in this script.`)
			process.exit(1)
		}
		const html = await localHtml(slug)
		await call("POST", `/fetch/sequences/${sequenceId}/emails/templates`, {
			site_uuid: SITE_UUID,
			email_template: {
				subject,
				html,
				delay_interval: "days",
				delay_interval_count: DELAY_DAYS[slug] ?? 0,
			},
		})
		console.log(`✓ ${slug} → sequence ${sequenceId}  (+${DELAY_DAYS[slug] ?? 0}d)  "${subject}"`)
	}
	console.log("\nTemplates created as drafts inside the sequence — review in the Bento dashboard.")
	process.exit(0)
}

console.error("Usage: bento:templates <list|diff|push>")
process.exit(1)
