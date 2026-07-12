import { MapleFlush } from "@maple-dev/effect-sdk/client"
import { ANTICIPATED_ERROR_TAGS } from "@maple/domain/anticipated-errors"
import { ingestUrl } from "./ingest-url"

// Buffer-backed client telemetry with flush-on-unload. `Maple.layer`
// (`Otlp.layerJson`) exports on a 5s timer and never flushes on `pagehide`, so
// the tail of a session — including a page's root query span, which finishes
// last after its child queries — was silently dropped before the next tick on a
// hard nav/tab-close, leaving rootless traces. `MapleFlush` swaps in the
// buffer-backed tracer and registers `pagehide` + `visibilitychange→hidden`
// handlers (on by default) that drain the buffer before the tab goes away.
// Traces + logs only — maple-web emits no client Effect metrics, so nothing is
// lost vs. `Maple.layer`. `service.namespace` moves into `attributes` because
// the flushable config has no dedicated field for it.
const telemetry = MapleFlush.make({
	serviceName: "maple-web",
	endpoint: ingestUrl,
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	environment: import.meta.env.MODE,
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
	attributes: {
		"service.namespace": "client",
		"vcs.repository.url.full": "https://github.com/Makisuo/maple",
		...(import.meta.env.VITE_COMMIT_SHA
			? { "vcs.ref.head.revision": import.meta.env.VITE_COMMIT_SHA }
			: {}),
	},
	// Expected 4xx API responses (the maple-web → maple-api edge surfaces these
	// as client-span failures) record as Ok instead of errors.
	anticipatedErrorTags: [...ANTICIPATED_ERROR_TAGS],
})

export const mapleOtelLayer = telemetry.layer
