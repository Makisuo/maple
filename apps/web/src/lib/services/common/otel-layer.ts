import { Maple } from "@maple-dev/effect-sdk/client"
import { ingestUrl } from "./ingest-url"

export const mapleOtelLayer = Maple.layer({
	serviceName: "maple-web",
	endpoint: ingestUrl,
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	environment: import.meta.env.MODE,
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
})
