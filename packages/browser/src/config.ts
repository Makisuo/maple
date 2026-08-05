import {
	type IdentifyInput,
	type MapleIdentity,
	normalizeIdentity,
	type ResolvedIdentity,
} from "@maple/browser-session"

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
	/**
	 * Optional user id attached to replay sessions and future browser spans.
	 *
	 * @deprecated Pass `user` instead — it carries email, name, and the
	 * company/team grouping the Sessions UI can filter by.
	 */
	readonly userId?: string | null | undefined
	/** End-user identity attached to sessions and browser spans. */
	readonly user?: MapleIdentity | undefined
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
		/**
		 * Store a persistent visitor id (localStorage) so unique visitors and
		 * new-vs-returning are measurable. Default true. Turning it off also
		 * purges any id already stored.
		 */
		readonly persistVisitorId?: boolean
		/**
		 * Scope the visitor-id cookie to the registered domain, so a marketing site
		 * and an app on sibling subdomains (`example.com` and `app.example.com`)
		 * resolve to the same visitor and a pre-signup visit links to the account it
		 * becomes. Default true. Set false to keep the cookie host-only.
		 */
		readonly crossSubdomainCookie?: boolean
		/**
		 * Explicit cookie `Domain=` (no leading dot), e.g. `"example.com"`. Defaults
		 * to the broadest domain the browser accepts, discovered by probing. `""`
		 * forces a host-only cookie.
		 */
		readonly cookieDomain?: string
		/** Capture nothing until `MapleBrowser.setConsent(true)`. Default false. */
		readonly requireConsent?: boolean
		/** Send `identify()`'s email to the warehouse. Default true. */
		readonly captureUserEmail?: boolean
		/** Treat `navigator.doNotTrack` like Global Privacy Control. Default false. */
		readonly respectDoNotTrack?: boolean
	}
}

export interface ResolvedConfig {
	readonly ingestKey: string
	readonly serviceName: string
	readonly endpoint: string
	readonly serviceNamespace: string | undefined
	readonly serviceVersion: string | undefined
	readonly environment: string | undefined
	/** Mutable: `MapleBrowser.identify()` can attach/replace/clear the identity after init. */
	identity: ResolvedIdentity | undefined
	readonly tracingEnabled: boolean
	readonly tracingInstrumentFetch: boolean
	readonly replayEnabled: boolean
	readonly replaySampleRate: number
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
	readonly persistVisitorId: boolean
	readonly crossSubdomainCookie: boolean
	readonly cookieDomain: string | undefined
	readonly requireConsent: boolean
	readonly captureUserEmail: boolean
	readonly respectDoNotTrack: boolean
}

const DEFAULT_ENDPOINT = "https://ingest.maple.dev"

/**
 * Resolve the identity from either the new `user` object or the legacy
 * `userId` string. `user` wins when both are set.
 */
export function resolveIdentity(config: {
	readonly user?: MapleIdentity | undefined
	readonly userId?: string | null | undefined
}): ResolvedIdentity | undefined {
	return normalizeIdentity((config.user ?? config.userId) as IdentifyInput)
}

export function resolveConfig(config: MapleBrowserConfig): ResolvedConfig {
	return {
		ingestKey: config.ingestKey,
		serviceName: config.serviceName,
		endpoint: (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, ""),
		serviceNamespace: config.serviceNamespace,
		serviceVersion: config.serviceVersion,
		environment: config.environment,
		identity: resolveIdentity(config),
		tracingEnabled: config.tracing?.enabled ?? true,
		tracingInstrumentFetch: config.tracing?.instrumentFetch ?? true,
		replayEnabled: config.replay?.enabled ?? true,
		replaySampleRate: config.replay?.sampleRate ?? 1,
		maskAllInputs: config.privacy?.maskAllInputs ?? true,
		maskAllText: config.privacy?.maskAllText ?? false,
		persistVisitorId: config.privacy?.persistVisitorId ?? true,
		crossSubdomainCookie: config.privacy?.crossSubdomainCookie ?? true,
		cookieDomain: config.privacy?.cookieDomain,
		requireConsent: config.privacy?.requireConsent ?? false,
		captureUserEmail: config.privacy?.captureUserEmail ?? true,
		respectDoNotTrack: config.privacy?.respectDoNotTrack ?? false,
	}
}
