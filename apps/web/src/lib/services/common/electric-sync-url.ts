const configuredElectricSyncUrl = import.meta.env.VITE_ELECTRIC_SYNC_URL?.trim()

/**
 * Origin of the standalone ElectricSQL shape-proxy worker (`apps/electric-sync`).
 * Set at build time via `VITE_ELECTRIC_SYNC_URL`; defaults to the local worker's
 * dev port (see `apps/electric-sync/package.json` `dev:app`).
 */
export const electricSyncBaseUrl =
	configuredElectricSyncUrl && configuredElectricSyncUrl.length > 0
		? configuredElectricSyncUrl.replace(/\/$/, "")
		: "http://127.0.0.1:3476"
