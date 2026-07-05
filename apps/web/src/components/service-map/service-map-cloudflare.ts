import { CloudflareIcon, type IconComponent } from "@/components/icons"

// Cloudflare direct-integration nodes (zones + Workers) sourced from the
// analytics poller's metrics. Mirrors `service-map-db.tsx`'s descriptor pattern
// so the icon, color, and category label stay consistent across the node, the
// detail panel, and any legend. Kept free of `service-map-utils` imports so the
// utils → descriptor dependency stays one-directional (no cycle).

export const CF_NODE_PREFIX = "cf:"

export const cfNodeId = (serviceName: string) => `${CF_NODE_PREFIX}${encodeURIComponent(serviceName)}`

export const isCfNodeId = (id: string) => id.startsWith(CF_NODE_PREFIX)

export type CloudflareNodeKind = "cloudflare-zone" | "cloudflare-worker"

/** Cloudflare brand orange — canonical source for `PLATFORM_COLORS.cloudflare` and the detail-panel icon. */
export const CLOUDFLARE_COLOR = "oklch(0.7 0.16 50)"

export interface CloudflareDescriptor {
	/** Node silhouette label ("Zone" / "Worker"). */
	category: "Zone" | "Worker"
	Icon: IconComponent
	/** Friendly tooltip label. */
	label: string
	/** Brand color for the accent stripe / icon / minimap. */
	color: string
}

export function getCloudflareDescriptor(kind: CloudflareNodeKind): CloudflareDescriptor {
	const isWorker = kind === "cloudflare-worker"
	return {
		category: isWorker ? "Worker" : "Zone",
		Icon: CloudflareIcon,
		label: isWorker ? "Cloudflare Worker" : "Cloudflare Zone",
		color: CLOUDFLARE_COLOR,
	}
}

/** Shared color accessor so `service-map-utils` doesn't hard-code the hue. */
export const getCfColor = (): string => CLOUDFLARE_COLOR
