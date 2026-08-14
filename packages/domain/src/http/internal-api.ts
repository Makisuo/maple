import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { AiTriageApiGroup } from "./ai-triage"
import { BillingApiGroup } from "./billing"
import { ChatApiGroup } from "./chat"
import { DemoApiGroup } from "./demo"
import { DigestApiGroup } from "./digest"
import { QueryEngineApiGroup } from "./query-engine"
import { SessionReplaysInternalApiGroup } from "./session-replay"
import { V1SchemaErrors, V1UnexpectedErrors } from "./v1-boundary"

/**
 * The dashboard's private transport.
 *
 * Deliberately a separate `HttpApi` from `MapleApi` rather than another group
 * inside it. Two things follow from the split, and both are the point:
 * `/docs` is generated from `MapleApi`, so these operations stop being
 * published as public API; and the groups here can carry session-only
 * authorization without loosening it for anything else.
 *
 * What belongs here is transport whose request and response shapes are allowed
 * to change with the UI — raw SQL, generic query documents, dashboard-builder
 * facet discovery, infrastructure drill-downs — plus the dashboard-only product
 * workflows (checkout and billing controls, digest subscriptions, demo seeding,
 * AI-triage settings, applying an approval-gated chat proposal) that were never
 * public API and only ever lived under `/api` because that was the one HttpApi
 * at the time. Nothing here is a stable
 * public contract, and nothing here should be promoted to `/v2` without a
 * deliberate redesign of its shape first. See `docs/http-api-migration.md`.
 *
 * `billingPublic` deliberately stays on `MapleApi`: the plan catalog is served
 * unauthenticated so a token-settle gap renders prices instead of a 401, which
 * session-only authorization would defeat.
 *
 * The error envelope is v1's on purpose: `apps/web` already decodes it, so the
 * split costs the frontend nothing.
 */
export class MapleInternalApi extends HttpApi.make("MapleInternalApi")
	.add(AiTriageApiGroup)
	.add(BillingApiGroup)
	.add(ChatApiGroup)
	.add(DemoApiGroup)
	.add(DigestApiGroup)
	.add(QueryEngineApiGroup)
	.add(SessionReplaysInternalApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple Internal API",
			version: "1.0.0",
			description:
				"Private dashboard transport. Not public API, not documented, not stable — do not build against it.",
		}),
	) {}
