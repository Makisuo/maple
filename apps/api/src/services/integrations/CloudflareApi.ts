/**
 * Lazy facade over {@link CloudflareApiImpl}, which owns the actual
 * `@distilled.cloud/cloudflare` wrapper. The distilled SDK is a large module
 * graph (generated services + schemas, ~2.4MB of source) that only the
 * Cloudflare-integration flows ever touch, so the impl is loaded via dynamic
 * import on first call instead of riding statically into every chunk that can
 * reach the integrations services (which includes the request-path graph).
 *
 * Every export here mirrors the impl's signature exactly — callers keep
 * importing from `CloudflareApi` and cannot tell the difference. New impl
 * exports must be mirrored here by hand; the `typeof Impl.*` annotations make
 * a drifted signature a type error.
 */
import { Effect } from "effect"
import type * as Impl from "./CloudflareApiImpl"

export type {
	CloudflareAccount,
	CloudflareApiError,
	CloudflareGraphqlError,
	CloudflareGraphqlResult,
	CloudflareHyperdriveConfig,
	CloudflareZone,
} from "./CloudflareApiImpl"

const impl = Effect.promise(() => import("./CloudflareApiImpl"))

export const listAccounts: typeof Impl.listAccounts = (...args) =>
	Effect.flatMap(impl, (m) => m.listAccounts(...args))

export const listZones: typeof Impl.listZones = (...args) =>
	Effect.flatMap(impl, (m) => m.listZones(...args))

export const listWorkerScripts: typeof Impl.listWorkerScripts = (...args) =>
	Effect.flatMap(impl, (m) => m.listWorkerScripts(...args))

export const listHyperdriveConfigs: typeof Impl.listHyperdriveConfigs = (...args) =>
	Effect.flatMap(impl, (m) => m.listHyperdriveConfigs(...args))

export const graphqlQuery: typeof Impl.graphqlQuery = (...args) =>
	Effect.flatMap(impl, (m) => m.graphqlQuery(...args))
