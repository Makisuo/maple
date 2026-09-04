import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

declare global {
	// `caches.default` is a Cloudflare Workers runtime extension to the standard
	// Cache API. The DOM `CacheStorage` lib type (pulled in by consumers that set
	// `lib: ["DOM"]`, e.g. apps/api) omits it. This augmentation matches
	// `@cloudflare/workers-types`' own `readonly default: Cache` declaration
	// exactly, so the property merges cleanly under workers-types and is added
	// under DOM — letting `caches.default` type without a cast in either config.
	interface CacheStorage {
		readonly default: Cache
	}
}

/**
 * The Cloudflare Workers default cache (`caches.default`), or `null` outside a
 * Workers runtime (Node, vitest, non-Workers hosts). Unlike D1/KV/R2 this is a
 * runtime *global*, not an `env` binding — but wrapping it as a service keeps
 * consumers behind Effect DI (overridable in tests) instead of poking globalThis.
 *
 * The layer is built in request scope (the worker builds its runtime lazily on
 * first request), so the read is allowed and cannot throw; the `typeof` guard
 * handles non-Workers runtimes where the global is absent.
 */
export class WorkersCache extends Context.Service<WorkersCache, Cache | null>()(
	"Cloudflare.Workers.WorkersCache",
) {
	static readonly layer: Layer.Layer<WorkersCache> = Layer.sync(this, () =>
		typeof caches !== "undefined" ? caches.default : null,
	)
}
