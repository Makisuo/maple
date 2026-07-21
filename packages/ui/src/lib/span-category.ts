import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CodeIcon,
	DatabaseIcon,
	GlobeIcon,
	PulseIcon,
} from "../components/icons"
import type { IconComponent } from "../components/icons"

import { getCacheInfo } from "./cache"
import type { CacheInfo } from "./cache"
import { extractClassName } from "./colors"
import { getCloudPlatform } from "./cloud-platforms"
import type { CloudPlatformInfo } from "./cloud-platforms"
import { getHttpInfo } from "./http"
import type { HttpInfo } from "./http"
import type { Span } from "./types"

export const SPAN_KIND_LABELS: Record<string, string> = {
	SPAN_KIND_SERVER: "Server",
	SPAN_KIND_CLIENT: "Client",
	SPAN_KIND_PRODUCER: "Producer",
	SPAN_KIND_CONSUMER: "Consumer",
	SPAN_KIND_INTERNAL: "Internal",
}

export type SpanCategoryId =
	| "server"
	| "http"
	| "db"
	| "cache"
	| "messaging"
	| "platform"
	| "function"
	| "internal"

export interface SpanCategoryAccent {
	/** Solid accent surface — cost rail fill, legend swatch. */
	rail: string
	/** Accent-tinted text/icon color. */
	text: string
	/** Soft accent surface for the icon chip — matches the badge `bg-x/15` idiom. */
	soft: string
}

export interface SpanCategory {
	id: SpanCategoryId
	label: string
	Icon: IconComponent
	accent: SpanCategoryAccent
}

// Accents reuse the theme-tuned chart/severity tokens so light and dark both
// come for free. The six common categories (server/http/db/cache/function/
// internal) get maximally distinct hues per theme; the rare ones (messaging,
// platform) accept near-collisions — chart-throughput ≈ chart-5 in dark and
// chart-p95 ≈ chart-1 in dark — where icon and label carry the distinction.
const ACCENTS: Record<SpanCategoryId, SpanCategoryAccent> = {
	server: { rail: "bg-chart-1", text: "text-chart-1", soft: "bg-chart-1/15" },
	http: { rail: "bg-chart-2", text: "text-chart-2", soft: "bg-chart-2/15" },
	db: { rail: "bg-chart-3", text: "text-chart-3", soft: "bg-chart-3/15" },
	cache: { rail: "bg-chart-4", text: "text-chart-4", soft: "bg-chart-4/15" },
	function: { rail: "bg-chart-5", text: "text-chart-5", soft: "bg-chart-5/15" },
	messaging: { rail: "bg-chart-throughput", text: "text-chart-throughput", soft: "bg-chart-throughput/15" },
	platform: { rail: "bg-chart-p95", text: "text-chart-p95", soft: "bg-chart-p95/15" },
	internal: { rail: "bg-severity-trace", text: "text-severity-trace", soft: "bg-severity-trace/15" },
}

/** Ordered legend entries — default label/icon per category. */
export const SPAN_CATEGORIES: ReadonlyArray<SpanCategory> = [
	{ id: "server", label: "Server", Icon: PulseIcon, accent: ACCENTS.server },
	{ id: "http", label: "HTTP", Icon: GlobeIcon, accent: ACCENTS.http },
	{ id: "db", label: "Database", Icon: DatabaseIcon, accent: ACCENTS.db },
	{ id: "cache", label: "Cache", Icon: DatabaseIcon, accent: ACCENTS.cache },
	{ id: "messaging", label: "Messaging", Icon: ArrowRightIcon, accent: ACCENTS.messaging },
	{ id: "platform", label: "Platform", Icon: GlobeIcon, accent: ACCENTS.platform },
	{ id: "function", label: "Function", Icon: CodeIcon, accent: ACCENTS.function },
	{ id: "internal", label: "Internal", Icon: CodeIcon, accent: ACCENTS.internal },
]

export type SpanCategoryInput = Pick<Span, "spanName" | "spanKind"> & {
	spanAttributes?: Record<string, string>
}

export interface SpanDescription {
	category: SpanCategory
	httpInfo: HttpInfo | null
	cacheInfo: CacheInfo | null
	platform: CloudPlatformInfo | null
	/** Class part of a `Class.method` span name, when the span reads as a function call. */
	className: string | null
}

/**
 * Categorize a span for display. Runs every detector once and returns them all
 * so consumers (flow cards, rows) don't re-derive.
 *
 * Order matters: cache before platform/db (Redis spans also carry db.* attrs),
 * platform adapters before HTTP (a Cloudflare fetch span is a platform span
 * first), HTTP before raw span-kind fallbacks.
 */
export function describeSpan(span: SpanCategoryInput): SpanDescription {
	const attrs = span.spanAttributes ?? {}
	const cacheInfo = getCacheInfo(attrs)
	const platform = getCloudPlatform(attrs)
	const httpInfo = getHttpInfo(span)
	const className = extractClassName(span.spanName)

	const category = ((): SpanCategory => {
		if (cacheInfo) {
			return {
				id: "cache",
				label: cacheInfo.system ?? "Cache",
				Icon: DatabaseIcon,
				accent: ACCENTS.cache,
			}
		}
		if (platform) {
			if (platform.id === "database") {
				return { id: "db", label: platform.label, Icon: DatabaseIcon, accent: ACCENTS.db }
			}
			return { id: "platform", label: platform.kind, Icon: platform.Icon, accent: ACCENTS.platform }
		}
		if (httpInfo) {
			return httpInfo.kind === "server" || span.spanKind === "SPAN_KIND_SERVER"
				? { id: "server", label: "Server", Icon: PulseIcon, accent: ACCENTS.server }
				: { id: "http", label: "HTTP", Icon: GlobeIcon, accent: ACCENTS.http }
		}
		if (span.spanKind === "SPAN_KIND_SERVER") {
			return { id: "server", label: "Server", Icon: PulseIcon, accent: ACCENTS.server }
		}
		if (span.spanKind === "SPAN_KIND_PRODUCER" || span.spanKind === "SPAN_KIND_CONSUMER") {
			const isProducer = span.spanKind === "SPAN_KIND_PRODUCER"
			return {
				id: "messaging",
				label: SPAN_KIND_LABELS[span.spanKind],
				Icon: isProducer ? ArrowRightIcon : ArrowLeftIcon,
				accent: ACCENTS.messaging,
			}
		}
		if (className) {
			return { id: "function", label: "Function", Icon: CodeIcon, accent: ACCENTS.function }
		}
		const kindLabel =
			SPAN_KIND_LABELS[span.spanKind] ?? (span.spanKind.replace("SPAN_KIND_", "") || "Internal")
		return { id: "internal", label: kindLabel, Icon: CodeIcon, accent: ACCENTS.internal }
	})()

	return { category, httpInfo, cacheInfo, platform, className }
}
