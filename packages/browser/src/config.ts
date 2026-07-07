/** Public configuration for `MapleBrowser.init`. */
export interface MapleBrowserConfig {
	/** Public ingest key (`maple_pk_...`). */
	readonly ingestKey: string
	/** Service name reported on traces and stored on replay sessions. */
	readonly serviceName: string
	/** Maple ingest base URL. Defaults to `https://ingest.maple.dev`. */
	readonly endpoint?: string
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute on traces. Optional.
	 */
	readonly serviceNamespace?: string
	/** Service version / commit SHA. */
	readonly serviceVersion?: string
	/** Deployment environment, e.g. "production". */
	readonly environment?: string
	/** Optional user id attached to the replay session. */
	readonly userId?: string
	readonly tracing?: {
		/** Default true. */
		readonly enabled?: boolean
		/**
		 * Auto-instrument `fetch()` to create network spans. Default true. Set
		 * false when another tracer (e.g. the Effect client SDK) already
		 * instruments requests — those spans feed the session via the published
		 * sink, and disabling this avoids redundant duplicate network spans.
		 */
		readonly instrumentFetch?: boolean
	}
	readonly replay?: {
		/** Default true. */
		readonly enabled?: boolean
		/** Fraction of sessions to record, 0–1. Default 1. */
		readonly sampleRate?: number
	}
	readonly privacy?: {
		/** Mask all `<input>` values. Default true. */
		readonly maskAllInputs?: boolean
		/**
		 * Mask all text in the rrweb recording and omit captured click target
		 * text from session events. Default false.
		 */
		readonly maskAllText?: boolean
	}
}

export interface ResolvedConfig {
	readonly ingestKey: string
	readonly serviceName: string
	readonly endpoint: string
	readonly serviceNamespace: string | undefined
	readonly serviceVersion: string | undefined
	readonly environment: string | undefined
	/** Mutable: `MapleBrowser.identify()` can attach/replace the user id after init. */
	userId: string | undefined
	readonly tracingEnabled: boolean
	readonly tracingInstrumentFetch: boolean
	readonly replayEnabled: boolean
	readonly replaySampleRate: number
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
}

const DEFAULT_ENDPOINT = "https://ingest.maple.dev"

export function resolveConfig(config: MapleBrowserConfig): ResolvedConfig {
	return {
		ingestKey: config.ingestKey,
		serviceName: config.serviceName,
		endpoint: (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, ""),
		serviceNamespace: config.serviceNamespace,
		serviceVersion: config.serviceVersion,
		environment: config.environment,
		userId: config.userId,
		tracingEnabled: config.tracing?.enabled ?? true,
		tracingInstrumentFetch: config.tracing?.instrumentFetch ?? true,
		replayEnabled: config.replay?.enabled ?? true,
		replaySampleRate: config.replay?.sampleRate ?? 1,
		maskAllInputs: config.privacy?.maskAllInputs ?? true,
		maskAllText: config.privacy?.maskAllText ?? false,
	}
}
