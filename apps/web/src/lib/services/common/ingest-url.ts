const configuredIngestUrl = import.meta.env.VITE_INGEST_URL?.trim()

export const ingestUrl =
	configuredIngestUrl && configuredIngestUrl.length > 0
		? configuredIngestUrl.replace(/\/$/, "")
		: "https://ingest.maple.dev"
