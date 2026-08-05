/**
 * Local-only helper to preview the alert AI-diagnosis readout without the
 * deployed Workers-AI binding.
 *
 * It seeds an OPEN alert incident + a COMPLETED `ai_triage_runs` row (with a
 * realistic structured result) for the most recent alert rule in your dev
 * Postgres, then prints the URL to open.
 *
 *   bun run --cwd packages/db scripts/seed-alert-diagnosis.ts           # newest rule
 *   bun run --cwd packages/db scripts/seed-alert-diagnosis.ts <ruleId>  # a specific rule
 *
 * Cleanup:
 *   bun run --cwd packages/db scripts/seed-alert-diagnosis.ts --clean
 *
 * Requires the dev Postgres (`bun db:up && bun db:migrate:local`).
 */
import { randomUUID } from "node:crypto"
import postgres from "postgres"

const DSN = process.env.MAPLE_DEV_PG ?? "postgres://maple:maple@localhost:5499/maple"
const TAG = "seed-alert-diagnosis" // dedupeKey marker so --clean only removes our rows
const sql = postgres(DSN)

const result = {
	summary:
		"Checkout error rate jumped to 18% right after payment-service v2.3.1 rolled out at 16:02. The spike is isolated to the /checkout/confirm path; upstream traffic is healthy.",
	suspectedCause:
		"Regression in payment-service v2.3.1 — the new Stripe client times out on idempotency-key retries, surfacing as 502s on checkout-api/confirm.",
	severityAssessment: "high",
	affectedScope: "checkout-api · /checkout/confirm · ~18% of confirm requests, ~240 users in the last 5m",
	evidence: [
		{
			traceIds: ["0af7651916cd43dd8448eb211c80319c", "4bf92f3577b34da6a3ce929d0e0e4736"],
			logPatterns: ["upstream timeout after 30000ms"],
			relatedServices: ["payment-service", "checkout-api"],
			note: "Both representative traces fail in payment-service.StripeClient.charge with a 30s timeout, then checkout-api returns 502.",
		},
		{
			traceIds: [],
			logPatterns: ["idempotency key replay rejected"],
			relatedServices: ["payment-service"],
			note: "payment-service logs show idempotency-key replays being rejected since the 16:02 deploy — absent in the prior build.",
		},
	],
	suggestedActions: [
		"Roll back payment-service to v2.3.0 to stop the bleeding.",
		"Check the Stripe client timeout/retry config introduced in v2.3.1.",
		"Confirm checkout-api/confirm error rate returns below 5% after rollback.",
	],
	confidence: "high",
}

async function clean() {
	const inc = await sql`delete from alert_incidents where dedupe_key like ${"%:" + TAG} returning id`
	if (inc.length) {
		await sql`delete from ai_triage_runs where incident_id in ${sql(inc.map((r) => r.id))}`
	}
	console.log(`Removed ${inc.length} seeded incident(s) and their diagnosis runs.`)
}

async function seed(ruleId?: string) {
	const rule = (
		ruleId
			? await sql`select id, org_id, name, signal_type, comparator, threshold, severity from alert_rules where id = ${ruleId}`
			: await sql`select id, org_id, name, signal_type, comparator, threshold, severity from alert_rules order by created_at desc limit 1`
	)[0]
	if (!rule) {
		console.error("No alert rule found. Create one at /alerts first, or pass a rule id.")
		process.exit(1)
	}

	const incidentId = randomUUID()
	const now = new Date()
	await sql`insert into alert_incidents
		(id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
		 comparator, threshold, first_triggered_at, last_triggered_at, last_observed_value,
		 last_sample_count, dedupe_key, error_issue_id, created_at, updated_at)
		values (${incidentId}, ${rule.org_id}, ${rule.id}, ${"ikey-" + incidentId}, ${rule.name},
		 ${"checkout-api"}, ${rule.signal_type}, ${rule.severity}, ${"open"}, ${rule.comparator},
		 ${rule.threshold}, ${now}, ${now}, ${0.18}, ${240}, ${rule.org_id + ":" + TAG}, ${null}, ${now}, ${now})`

	await sql`insert into ai_triage_runs
		(id, org_id, incident_kind, incident_id, issue_id, status, context_json, result_json, model,
		 input_tokens, output_tokens, created_at, started_at, completed_at, updated_at)
		values (${randomUUID()}, ${rule.org_id}, ${"alert"}, ${incidentId}, ${null}, ${"completed"},
		 ${sql.json({ kind: "alert" })}, ${sql.json(result)}, ${"@cf/moonshotai/kimi-k2.6"}, ${1840},
		 ${320}, ${now}, ${now}, ${now}, ${now})`

	console.log(`Seeded a completed diagnosis on rule "${rule.name}".`)
	console.log(`Open:  /alerts/${rule.id}   (Overview tab)`)
}

const arg = process.argv[2]
await (arg === "--clean" ? clean() : seed(arg))
await sql.end()
