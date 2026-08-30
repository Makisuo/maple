const configuredElectricSyncUrl = import.meta.env.VITE_ELECTRIC_SYNC_URL?.trim()

const DEV_ELECTRIC_SYNC_ORIGIN = "http://127.0.0.1:3476"
const SYNC_SHAPE_PATH = "/api/sync/shape"

export const resolveElectricSyncBaseUrl = (input: {
	readonly configured: string | undefined
	readonly isDev: boolean
	readonly origin: string | undefined
}): string => {
	const configured = input.configured?.trim()
	if (configured && configured.length > 0) return configured.replace(/\/$/, "")
	if (input.isDev) return DEV_ELECTRIC_SYNC_ORIGIN
	return input.origin?.trim().replace(/\/$/, "") ?? ""
}

/**
 * ShapeStream (`@electric-sql/client`) does `new URL(url)` with no base, so a
 * relative `/api/sync/shape` throws. Empty `VITE_ELECTRIC_SYNC_URL` still means
 * same-origin behind Caddy — resolve it against the browser origin at call time.
 */
export const resolveSyncProxyUrl = (base: string): string => {
	if (base.length === 0) {
		throw new Error(
			"Electric ShapeStream requires an absolute URL; set VITE_ELECTRIC_SYNC_URL or run in a browser",
		)
	}
	return `${base}${SYNC_SHAPE_PATH}`
}

export const getElectricSyncBaseUrl = (): string =>
	resolveElectricSyncBaseUrl({
		configured: configuredElectricSyncUrl,
		isDev: import.meta.env.DEV,
		origin: typeof location !== "undefined" ? location.origin : undefined,
	})

export const getSyncProxyUrl = (): string => resolveSyncProxyUrl(getElectricSyncBaseUrl())

/**
 * Origin of the standalone ElectricSQL shape-proxy worker (`apps/electric-sync`).
 * Prefer {@link getElectricSyncBaseUrl} when the value is read after load —
 * production same-origin is `location.origin`, which is only defined in a browser.
 */
export const electricSyncBaseUrl = getElectricSyncBaseUrl()
