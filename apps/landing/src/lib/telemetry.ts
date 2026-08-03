/**
 * Maple's own browser telemetry on the marketing site.
 *
 * We sell session replay and product analytics, so the landing site runs the
 * public `@maple-dev/browser` SDK exactly as a customer would — same package,
 * same config surface. Two things follow from that:
 *
 * - The visitor id is a cookie scoped to the registered domain (see
 *   `packages/browser-session/src/visitor.ts`), so a visit to `maple.dev` and
 *   the session that follows on `app.maple.dev` resolve to the *same*
 *   `VisitorId`. That is the join that makes "which campaign produced this
 *   signup" answerable — the session ids stay separate on purpose.
 * - Replay is sampled rather than on: the marketing site is our highest-traffic
 *   surface and full rrweb capture there would dwarf the product's ingest.
 *
 * Privacy posture matches what the site already did with its third-party
 * analytics tag: no consent gate, inputs masked, and Global Privacy Control
 * honored by default (it suppresses the persistent visitor id).
 */

import { MapleBrowser, type TrackProps } from "@maple-dev/browser"

const INGEST_KEY = import.meta.env.PUBLIC_MAPLE_INGEST_KEY
const ENDPOINT = import.meta.env.PUBLIC_INGEST_URL || "https://ingest.maple.dev"
const REPLAY_SAMPLE_RATE = Number(import.meta.env.PUBLIC_MAPLE_REPLAY_SAMPLE_RATE ?? "0.1")
/**
 * Escape hatch for hosts where the cookie-domain probe can't find a shared
 * parent — chiefly local dev, where browsers make `*.localhost` cookies
 * host-only and `landing.localhost` / `web.localhost` would never link.
 */
const COOKIE_DOMAIN = import.meta.env.PUBLIC_MAPLE_COOKIE_DOMAIN

/**
 * Event names, `object_action`. Keeping them in a closed set rather than
 * free-form strings is what stops `cta_click` and `clicked_cta` from both
 * existing three months from now — the warehouse has no schema to catch it.
 *
 * This is a runtime set, not just a union, because the `data-track` attributes
 * below are strings in markup that no compiler ever sees. The type is derived
 * from it so the two cannot drift.
 */
export const LANDING_EVENTS = [
	"cta_click",
	"pricing_plan_selected",
	"pricing_calculator_changed",
	"install_command_copied",
	"docs_search",
] as const

export type LandingEvent = (typeof LANDING_EVENTS)[number]

function isLandingEvent(name: string): name is LandingEvent {
	return (LANDING_EVENTS as ReadonlyArray<string>).includes(name)
}

let started = false

/**
 * Initialize telemetry and bind the declarative `data-track` handler. Safe to
 * call on every page load; Astro is MPA, so it runs once per navigation and the
 * session/visitor identifiers carry across.
 */
export function startLandingTelemetry(): void {
	// No key configured (fresh clone, `astro dev` without env) — stay silent
	// rather than post a marketing site's traffic at whatever the default is.
	if (started || !INGEST_KEY || typeof window === "undefined") return
	started = true

	MapleBrowser.init({
		ingestKey: INGEST_KEY,
		endpoint: ENDPOINT,
		serviceName: "maple-landing",
		serviceNamespace: "client",
		environment: import.meta.env.MODE,
		replay: {
			enabled: true,
			sampleRate: Number.isFinite(REPLAY_SAMPLE_RATE) ? REPLAY_SAMPLE_RATE : 0.1,
		},
		privacy: {
			maskAllInputs: true,
			// Empty means "unset" — the SDK's probe finds the shared domain on its
			// own, and an explicit "" would pin the cookie host-only in production.
			...(COOKIE_DOMAIN ? { cookieDomain: COOKIE_DOMAIN } : {}),
		},
	})

	bindDeclarativeTracking()
}

/** Record a custom event. No-ops before init; the SDK queues pre-init events. */
export function trackLanding(event: LandingEvent, props?: TrackProps): void {
	MapleBrowser.track(event, props)
}

/**
 * Attach the signed-in user to the session. Called from the NavBar island,
 * which is the one place Clerk is mounted. The email is deliberately left off —
 * this is our own dogfooding instance, and the id is the join key that matters.
 */
export function identifyLanding(userId: string | null | undefined): void {
	MapleBrowser.identify(userId ? { id: userId } : null)
}

/**
 * One delegated click listener for `data-track` elements.
 *
 * Most of this site is static Astro with no islands, so the alternative to a
 * declarative hook is hydrating a React component per CTA just to attach an
 * onClick. `data-track-*` attributes become event properties:
 *
 * ```html
 * <a href="…" data-track="cta_click" data-track-location="hero">
 * ```
 */
function bindDeclarativeTracking(): void {
	document.addEventListener(
		"click",
		(event) => {
			const target = event.target
			if (!(target instanceof Element)) return
			const host = target.closest<HTMLElement>("[data-track]")
			const name = host?.dataset.track
			if (!host || !name) return
			// The markup is the one path into `track()` that the compiler never
			// checks, so a typo'd `data-track` would otherwise ship silently and
			// show up as a second event name in the warehouse weeks later.
			if (!isLandingEvent(name)) {
				if (import.meta.env.DEV) {
					console.warn(
						`[maple] ignoring unknown data-track="${name}" — add it to LANDING_EVENTS first.`,
					)
				}
				return
			}

			const props: Record<string, string> = {}
			for (const [key, value] of Object.entries(host.dataset)) {
				if (key === "track" || !key.startsWith("track") || value === undefined) continue
				// `data-track-location` → dataset.trackLocation → `location`.
				props[key.slice(5).replace(/^./, (c) => c.toLowerCase())] = value
			}
			trackLanding(name, props)
		},
		// Capture, so a handler that stops propagation (or a React island that
		// re-renders the node away) can't swallow the event first.
		{ capture: true },
	)
}
