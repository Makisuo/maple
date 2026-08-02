// ---------------------------------------------------------------------------
// Placeholder data for the session-replay detail PREVIEW route (/replays/preview)
//
// TEMPORARY: this exists so the polished detail page can be reviewed without a
// recorded session in the warehouse. It hand-builds a tiny-but-valid rrweb
// stream (Meta + FullSnapshot + a few interactions) plus matching trace
// summaries and a transcript, all sharing one epoch base so seeking lines up.
// Safe to delete along with the preview route.
// ---------------------------------------------------------------------------

import { EventType, IncrementalSource, MouseInteractions } from "@rrweb/types"
import type { SessionTraceSummary } from "./replay-editor-timeline"
import type { EventRow } from "./session-events-panel"

import { formatWarehouseDateTimeMs } from "@maple/query-engine"
// rrweb-snapshot NodeType (not re-exported from @rrweb/types).
const NodeType = { Document: 0, DocumentType: 1, Element: 2, Text: 3 } as const

/** The recording starts 5 minutes ago and runs for ~30s. */
const BASE_EPOCH_MS = Date.now() - 5 * 60 * 1000
const ts = (offsetMs: number) => BASE_EPOCH_MS + offsetMs
/** Epoch → ClickHouse DateTime64 string (UTC, space-separated) for warehouse-shaped rows. */
const ch = (offsetMs: number) => formatWarehouseDateTimeMs(BASE_EPOCH_MS + offsetMs)

const VIEWPORT = { width: 1280, height: 720 }
const INITIAL_URL = "https://app.acme.dev/dashboard"
const SETTINGS_URL = "https://app.acme.dev/settings"

// --- Serialized DOM snapshot ------------------------------------------------
// Explicit, unique node ids; the interaction events below reference a few of
// them (search input = 32, refresh button = 33, body = 7).

const STYLE = `
*{box-sizing:border-box;margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
body{background:linear-gradient(135deg,#eef2ff,#faf5ff);color:#0f172a;padding:0}
.bar{display:flex;align-items:center;gap:10px;padding:16px 28px;background:#fff;border-bottom:1px solid #e2e8f0}
.dot{width:14px;height:14px;border-radius:50%;background:#6366f1}
.brand{font-weight:700;font-size:18px;letter-spacing:-.01em}
.main{padding:40px 48px}
h1{font-size:34px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
.sub{color:#64748b;font-size:16px;margin-bottom:32px}
.stats{display:flex;gap:20px;margin-bottom:32px}
.stat{flex:1;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:22px 24px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.num{font-size:32px;font-weight:700;letter-spacing:-.02em}
.lbl{color:#64748b;font-size:13px;margin-top:6px;text-transform:uppercase;letter-spacing:.06em}
.row{display:flex;gap:14px;align-items:center}
.search{flex:1;padding:13px 16px;border:1px solid #cbd5e1;border-radius:12px;font-size:15px;background:#fff}
.btn{padding:13px 22px;border:none;border-radius:12px;background:#6366f1;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
`

const el = (id: number, tagName: string, attributes: Record<string, string>, childNodes: unknown[] = []) => ({
	type: NodeType.Element,
	tagName,
	attributes,
	childNodes,
	id,
})

const text = (id: number, textContent: string) => ({ type: NodeType.Text, textContent, id })

const stat = (baseId: number, num: string, label: string) =>
	el(baseId, "div", { class: "stat" }, [
		el(baseId + 1, "div", { class: "num" }, [text(baseId + 2, num)]),
		el(baseId + 3, "div", { class: "lbl" }, [text(baseId + 4, label)]),
	])

const documentNode = {
	type: NodeType.Document,
	id: 1,
	childNodes: [
		{ type: NodeType.DocumentType, name: "html", publicId: "", systemId: "", id: 2 },
		el(3, "html", { lang: "en" }, [
			el(4, "head", {}, [el(5, "style", {}, [text(6, STYLE)])]),
			el(7, "body", {}, [
				el(8, "div", { class: "app" }, [
					el(9, "div", { class: "bar" }, [
						el(10, "span", { class: "dot" }, []),
						el(11, "span", { class: "brand" }, [text(12, "Acme Analytics")]),
					]),
					el(13, "div", { class: "main" }, [
						el(14, "h1", {}, [text(15, "Welcome back, Jordan 👋")]),
						el(16, "p", { class: "sub" }, [
							text(17, "Here's what happened while you were away."),
						]),
						el(18, "div", { class: "stats" }, [
							stat(20, "1,284", "Active users"),
							stat(25, "98.2%", "Uptime"),
							stat(30, "342ms", "p95 latency"),
						]),
						el(40, "div", { class: "row" }, [
							el(32, "input", { class: "search", placeholder: "Search dashboards…" }, []),
							el(33, "button", { class: "btn" }, [text(34, "Refresh data")]),
						]),
					]),
				]),
			]),
		]),
	],
}

// --- rrweb event stream -----------------------------------------------------

const meta = (offsetMs: number, href: string) => ({
	type: EventType.Meta,
	data: { href, ...VIEWPORT },
	timestamp: ts(offsetMs),
})

const click = (offsetMs: number, id: number, x: number, y: number) => ({
	type: EventType.IncrementalSnapshot,
	data: { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click, id, x, y },
	timestamp: ts(offsetMs),
})

const scroll = (offsetMs: number, y: number) => ({
	type: EventType.IncrementalSnapshot,
	data: { source: IncrementalSource.Scroll, id: 7, x: 0, y },
	timestamp: ts(offsetMs),
})

const input = (offsetMs: number, value: string) => ({
	type: EventType.IncrementalSnapshot,
	data: { source: IncrementalSource.Input, id: 32, text: value, isChecked: false },
	timestamp: ts(offsetMs),
})

const move = (offsetMs: number, x: number, y: number) => ({
	type: EventType.IncrementalSnapshot,
	data: { source: IncrementalSource.MouseMove, positions: [{ x, y, id: 7, timeOffset: 0 }] },
	timestamp: ts(offsetMs),
})

/** Tiny but valid rrweb replay: Meta + FullSnapshot, then ~30s of activity with an idle gap and a nav. */
export const PREVIEW_RRWEB_EVENTS: ReadonlyArray<unknown> = [
	meta(0, INITIAL_URL),
	{
		type: EventType.FullSnapshot,
		data: { node: documentNode, initialOffset: { left: 0, top: 0 } },
		timestamp: ts(50),
	},
	scroll(1500, 120),
	click(3000, 33, 1040, 470),
	input(5000, "latency"),
	move(5200, 620, 300),
	// 5.2s → 12s: idle gap (> 2s threshold) renders a hatched idle band.
	click(12000, 32, 360, 470),
	meta(15000, SETTINGS_URL), // URL change → "nav" marker
	scroll(18000, 480),
	click(22000, 33, 1040, 470),
	move(30000, 700, 360), // extend total length to ~30s
]

// --- Placeholder session metadata (shape consumed by the detail header/tiles) ---

export const PREVIEW_SESSION = {
	sessionId: "preview-7f3a9c2e10b4d8a6",
	startTime: ch(0),
	status: "ended",
	userId: "jordan@acme.dev",
	urlInitial: INITIAL_URL,
	durationMs: 30_000,
	activeTimeMs: 21_500,
	idleTimeMs: 8_500,
	browserName: "Chrome 138",
	osName: "macOS 15",
	deviceType: "desktop",
	country: "United States",
	serviceName: "acme-web",
	pageViews: 2,
	clickCount: 3,
	errorCount: 1,
} as const

// --- Correlated trace summaries (timeline "Traces" track) -------------------

export const PREVIEW_TRACE_SUMMARIES: ReadonlyArray<SessionTraceSummary> = [
	{
		traceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
		startTime: ch(3000),
		durationMs: 184,
		rootSpanName: "GET /api/dashboard",
		rootServiceName: "acme-web",
		spanCount: 12,
		hasError: 0,
	},
	{
		traceId: "b2c3d4e5f60718293a4b5c6d7e8f90a1",
		startTime: ch(12000),
		durationMs: 642,
		rootSpanName: "POST /api/search",
		rootServiceName: "search-svc",
		spanCount: 23,
		hasError: 0,
	},
	{
		traceId: "c3d4e5f60718293a4b5c6d7e8f90a1b2",
		startTime: ch(22000),
		durationMs: 1290,
		rootSpanName: "POST /api/refresh",
		rootServiceName: "ingest-worker",
		spanCount: 31,
		hasError: 1,
	},
]

// --- Distilled transcript (Console / Network / Errors panel) ----------------

const ev = (e: Partial<EventRow> & Pick<EventRow, "timestamp" | "type">): EventRow => ({
	url: INITIAL_URL,
	traceId: null,
	level: "",
	message: "",
	targetSelector: "",
	targetText: "",
	netMethod: "",
	netUrl: "",
	netStatus: 0,
	netDurationMs: 0,
	errorStack: "",
	...e,
})

export const PREVIEW_TRANSCRIPT: ReadonlyArray<EventRow> = [
	ev({ timestamp: ch(200), type: "console", level: "info", message: "App mounted in 142ms" }),
	ev({
		timestamp: ch(3000),
		type: "network",
		netMethod: "GET",
		netUrl: "/api/dashboard",
		netStatus: 200,
		netDurationMs: 184,
		traceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
	}),
	ev({ timestamp: ch(5100), type: "console", level: "log", message: "Search query: 'latency'" }),
	ev({
		timestamp: ch(12000),
		type: "network",
		netMethod: "POST",
		netUrl: "/api/search",
		netStatus: 200,
		netDurationMs: 642,
		traceId: "b2c3d4e5f60718293a4b5c6d7e8f90a1",
	}),
	ev({
		timestamp: ch(15000),
		type: "console",
		level: "warn",
		message: "Deprecated route /settings — migrate to /account",
	}),
	ev({
		timestamp: ch(22000),
		type: "network",
		netMethod: "POST",
		netUrl: "/api/refresh",
		netStatus: 500,
		netDurationMs: 1290,
		traceId: "c3d4e5f60718293a4b5c6d7e8f90a1b2",
	}),
	ev({
		timestamp: ch(22050),
		type: "error",
		message: "TypeError: Cannot read properties of undefined (reading 'rows')",
		errorStack:
			"TypeError: Cannot read properties of undefined (reading 'rows')\n  at renderTable (table.tsx:88)\n  at Dashboard (dashboard.tsx:142)",
		traceId: "c3d4e5f60718293a4b5c6d7e8f90a1b2",
	}),
	// A longer run of network calls so the preview exercises a scrollable list
	// (a short list hides whether the panel scrolls vs. inflates the layout).
	...Array.from({ length: 32 }, (_, i) =>
		ev({
			timestamp: ch(5000 + i * 500),
			type: "network",
			netMethod: i % 4 === 0 ? "GET" : "POST",
			netUrl: `/api/resource/${i}`,
			netStatus: i % 9 === 0 ? 500 : 200,
			netDurationMs: 40 + ((i * 137) % 1400),
		}),
	),
]
