import { MapleFlush } from "@maple-dev/effect-sdk/client"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { ingestUrl } from "./ingest-url"

// Buffer-backed client telemetry with flush-on-unload. `Maple.layer`
// (`Otlp.layerJson`) exports on a 5s timer and never flushes on `pagehide`, so
// the tail of a session — including a page's root query span, which finishes
// last after its child queries — was silently dropped before the next tick on a
// hard nav/tab-close, leaving rootless traces. `MapleFlush` swaps in the
// buffer-backed tracer and registers `pagehide` + `visibilitychange→hidden`
// handlers (on by default) that drain the buffer before the tab goes away.
// Traces, logs, and Effect metrics share the same unload-safe flush.
// `service.namespace` moves into `attributes` because
// the flushable config has no dedicated field for it.
const telemetry = MapleFlush.make({
	serviceName: "maple-web",
	endpoint: ingestUrl,
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	environment: import.meta.env.MODE,
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
	attributes: {
		"service.namespace": "client",
		"vcs.repository.url.full": "https://github.com/MapleTechLabs/maple",
		...(import.meta.env.VITE_COMMIT_SHA
			? { "vcs.ref.head.revision": import.meta.env.VITE_COMMIT_SHA }
			: undefined),
	},
	// Expected 4xx API responses (the maple-web → maple-api edge surfaces these
	// as client-span failures) record as Ok instead of errors.
	//
	// `WarehouseUnreachableError` joins them as the one non-4xx member: a browser
	// that briefly could not reach the API has not hit a fault worth
	// fingerprinting, and the span still carries the failure. Only failures
	// outlasting `PEER_OUTAGE_GRACE_MS` keep their reporting tag, so a genuine
	// outage is unaffected — see `peer-reachability.ts`.
	anticipatedErrorIdentifiers: [
		...ANTICIPATED_ERROR_IDENTIFIERS,
		"@maple/web/errors/WarehouseUnreachableError",
	],
	// rrweb self-recording. #225 disabled this while the recorder was pathological
	// (full-buffer re-stringify per flush, 30s DOM checkouts, unbounded buffer);
	// that same PR fixed all three (serialize-once at emit, 5-min checkouts, 4MB
	// cap, idle-scheduled flush), so it is back on. The perf-bench build sets
	// VITE_MAPLE_REPLAY=off — see playwright.config.ts.
	replay: { enabled: import.meta.env.VITE_MAPLE_REPLAY !== "off" },
	// In production the SDK probes its way to `.maple.dev` on its own, which is
	// what makes a visit to the marketing site and the session that follows here
	// resolve to one VisitorId. Local dev needs the override: browsers make
	// `*.localhost` cookies host-only, so web.localhost and landing.localhost
	// would each mint their own visitor.
	...(import.meta.env.VITE_MAPLE_COOKIE_DOMAIN
		? {
				privacy: { cookieDomain: import.meta.env.VITE_MAPLE_COOKIE_DOMAIN },
			}
		: undefined),
})

export const mapleOtelLayer = telemetry.layer

/**
 * Report an error that never went through an Effect span.
 *
 * The SDK's global handlers already cover uncaught throws and unhandled
 * rejections. This is for the one case they cannot see: React error boundaries
 * catch a render crash and, in production, swallow it — so the dashboard would
 * paint its crash screen and Maple would never hear about its own outage.
 */
export const captureException = telemetry.captureException
