// Leading icons for analytics breakdown rows.
//
// Two sources, one entry point. Host-shaped values (referrer, site, and the
// subset of utm_source that is a domain) get a remote favicon; browser and
// device get the local SVG marks the replays list already uses. Everything else
// gets nothing — a made-up icon is worse than no icon.
//
// About the favicon service (`favicon.maple.dev/?url=<host>`): it answers 200
// for *every* host, serving its own letter-monogram SVG when it can't find a
// real icon. So a client-side monogram fallback would be dead code, and `onError`
// only ever fires on a genuine network or service failure. That case renders an
// empty box of the same size rather than nothing, so a row whose icon fails does
// not shift its label out of line with the rows around it.

import { useState, type ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

import { browserIconFor, deviceIconFor } from "@/components/replays/session-icons"
import type { AnalyticsFilterKey } from "./filters"

/** Shared box size, so a favicon, an SVG mark and the empty fallback all agree. */
const ICON_BOX = "size-4 shrink-0"

export const faviconUrl = (host: string): string =>
	`https://favicon.maple.dev/?url=${encodeURIComponent(host)}`

/**
 * True for values that are plausibly a hostname (`google.com`, `t.co`).
 *
 * Only `utm_source` needs this: the referrer and site columns are hostnames by
 * construction (the ingest gateway parses them), but `utm_source` is free text
 * and is as often `newsletter` or `cpc` as it is a domain. Asking the favicon
 * service about `newsletter` returns an "N" monogram, which reads as a real
 * brand mark and is a lie.
 */
export const isHostLike = (value: string): boolean => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)

/**
 * The site's favicon, or a same-sized blank once the request has failed.
 *
 * `alt=""` + `aria-hidden` because the hostname is right beside it as text —
 * naming the image too just makes a screen reader say the host twice.
 */
export function Favicon({ host, className }: { host: string; className?: string }) {
	const [failed, setFailed] = useState(false)

	if (failed) return <span className={cn(ICON_BOX, className)} aria-hidden />

	return (
		<img
			src={faviconUrl(host)}
			alt=""
			aria-hidden
			loading="lazy"
			decoding="async"
			referrerPolicy="no-referrer"
			onError={() => setFailed(true)}
			className={cn(ICON_BOX, "rounded-[3px] object-contain", className)}
		/>
	)
}

/** Which dimensions render an icon at all — drives the alignment spacer. */
const ICON_KEYS = new Set<AnalyticsFilterKey>([
	"referrerHost",
	"host",
	"utmSource",
	"browserName",
	"deviceType",
])

export const dimensionHasIcons = (key: AnalyticsFilterKey): boolean => ICON_KEYS.has(key)

/**
 * The icon for one row of a breakdown, keyed off the dimension's filter key.
 *
 * Keyed off `filterKey` rather than a new per-dimension prop so the route's
 * dimension arrays stay declarations of *data*, and the sidebar — which has no
 * `BreakdownDimension` at all — can call the same function.
 *
 * Returns `undefined` when the row gets no icon, which for an icon-bearing
 * dimension (a non-domain `utm_source`) the caller renders as a spacer.
 */
export function analyticsRowIcon(key: AnalyticsFilterKey, name: string): ReactNode | undefined {
	switch (key) {
		case "referrerHost":
		case "host":
			return <Favicon host={name} />
		case "utmSource":
			return isHostLike(name) ? <Favicon host={name} /> : undefined
		case "browserName": {
			const Icon = browserIconFor(name)
			return <Icon className={ICON_BOX} />
		}
		case "deviceType": {
			const Icon = deviceIconFor(name)
			return <Icon className={cn(ICON_BOX, "text-muted-foreground")} />
		}
		default:
			return undefined
	}
}
