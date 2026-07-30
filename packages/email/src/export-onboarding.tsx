/// <reference types="@types/bun" />
/**
 * Render the four onboarding emails to static HTML for pasting into Bento.
 *
 *   bun run --cwd packages/email build:onboarding-html
 *
 * Bento owns the sequencing (timing, branching, suppression); these templates
 * stay the authoring source for the *content*. The only per-recipient value the
 * production call sites ever pass is `dashboardUrl`, so it is the only thing
 * that becomes a Liquid tag — everything else is baked in at render time.
 *
 * Re-run this after editing onboarding.tsx and re-paste, otherwise the repo and
 * Bento drift. See docs/onboarding-sequence.md.
 */
import { render } from "@react-email/components"
import { ActivationEmail, ConnectAppEmail, StalledEmail, WelcomeEmail } from "./onboarding"

/**
 * Rendered into `href` in place of the real URL, then swapped for the Liquid tag
 * below. A sentinel (rather than substituting the tag directly) keeps the render
 * output valid HTML and survives any URL escaping React Email applies.
 */
const DASHBOARD_URL_SENTINEL = "https://maple.invalid/__DASHBOARD_URL__"

/**
 * Bento resolves visitor fields as `{{ visitor.<field> }}`. The sync job writes
 * `maple_dashboard_url` onto the subscriber, so the sequence does not depend on
 * event payloads still being around when a delayed step fires.
 */
const DASHBOARD_URL_LIQUID = "{{ visitor.maple_dashboard_url }}"

const TEMPLATES = [
	{
		slug: "01-welcome",
		subject: "Welcome to Maple",
		// `trialDays` is deliberately omitted: production never passes it, so the
		// no-trial branch is the only one that has ever shipped.
		node: WelcomeEmail({ dashboardUrl: DASHBOARD_URL_SENTINEL }),
	},
	{
		slug: "02-connect-app",
		subject: "Connect your app to Maple",
		node: ConnectAppEmail({ dashboardUrl: DASHBOARD_URL_SENTINEL }),
	},
	{
		slug: "03-stalled",
		subject: "Need a hand connecting your app?",
		node: StalledEmail({ dashboardUrl: DASHBOARD_URL_SENTINEL }),
	},
	{
		slug: "04-activation",
		subject: "You're live on Maple",
		// `serviceName` is likewise never passed in production, so this renders the
		// "your services" fallback — the same copy customers have always received.
		node: ActivationEmail({ dashboardUrl: DASHBOARD_URL_SENTINEL }),
	},
]

/**
 * Committed on purpose, despite being generated. Bento is the deploy target for
 * this content and keeps no history we can review, so these files are the only
 * version-controlled record of what was pasted in — a diff here is the drift
 * signal. Hence `bento-html/`, not a `dist-` directory that reads as ignorable.
 */
const outDir = new URL("../bento-html/", import.meta.url).pathname

for (const template of TEMPLATES) {
	const rendered = await render(template.node)
	const html = rendered.replaceAll(DASHBOARD_URL_SENTINEL, DASHBOARD_URL_LIQUID)

	if (html.includes(DASHBOARD_URL_SENTINEL)) {
		throw new Error(`${template.slug}: sentinel survived substitution`)
	}
	if (!html.includes(DASHBOARD_URL_LIQUID)) {
		throw new Error(`${template.slug}: no Liquid tag in output — did the template stop using dashboardUrl?`)
	}

	const path = `${outDir}${template.slug}.html`
	await Bun.write(path, html)
	console.log(`✓ ${template.slug}  ${String(html.length).padStart(6)} chars  subject: ${template.subject}`)
}

console.log(`\nWrote ${TEMPLATES.length} templates -> ${outDir}`)
console.log(`Paste each into its Bento email, and set the subject line shown above.`)
console.log(`Liquid tag used: ${DASHBOARD_URL_LIQUID} (subscriber field maple_dashboard_url)`)
