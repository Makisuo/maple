const configuredIngestUrl = import.meta.env.VITE_INGEST_URL?.trim()

export const ingestUrl =
	configuredIngestUrl && configuredIngestUrl.length > 0
		? configuredIngestUrl.replace(/\/$/, "")
		: "http://127.0.0.1:3474"
