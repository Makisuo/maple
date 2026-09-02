/// <reference types="@types/bun" />
/**
 * Renders every sample variant through the production runtime and drops the
 * HTML in /tmp for eyeballing. Replaces the old `email dev` server — there is
 * no server to run any more, the renderers are pure functions.
 *
 * Usage: bun run --cwd packages/email preview
 */
import { renderAlertNotification } from "../src/alert-notification"
import {
	alertNotificationProps,
	criticalDigestProps,
	healthyDigestProps,
	multiEnvDigestProps,
	scopedDigestProps,
	watchDigestProps,
} from "../src/samples"
import { renderWeeklyDigest } from "../src/weekly-digest"

const OUT_DIR = "/tmp/maple-email-preview"

const variants: ReadonlyArray<{ name: string; html: string }> = [
	{ name: "weekly-digest-healthy", html: renderWeeklyDigest(healthyDigestProps) },
	{ name: "weekly-digest-watch", html: renderWeeklyDigest(watchDigestProps) },
	{ name: "weekly-digest-critical", html: renderWeeklyDigest(criticalDigestProps) },
	{ name: "weekly-digest-multi-env", html: renderWeeklyDigest(multiEnvDigestProps) },
	{ name: "weekly-digest-scoped", html: renderWeeklyDigest(scopedDigestProps) },
	{ name: "alert-notification", html: renderAlertNotification(alertNotificationProps) },
]

for (const { name, html } of variants) {
	const path = `${OUT_DIR}/${name}.html`
	await Bun.write(path, html)
	console.log(`${path} (${html.length} chars)`)
}
