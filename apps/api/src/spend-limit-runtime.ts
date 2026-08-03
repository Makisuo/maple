import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { EdgeCacheService, type EdgeCacheServiceShape } from "@maple/cache"
import { BillingCustomer, BillingUsage, CatalogPlan, OrgId } from "@maple/domain/http"
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect"
import { CacheBackendLive } from "./lib/CacheBackendLive"
import { layerPg } from "./lib/DatabasePgLive"
import { Env } from "./lib/Env"
import { decodeUpstream, ensureOk, makeCallAutumn, readCustomerCached } from "./lib/autumn-client"
import { evaluateSpendLimits } from "./lib/spend-limit-evaluation"
import { resolveCycleWindow } from "./routes/billing.http"
import {
	SpendLimitsService,
	type ConfiguredSpendLimits,
	type SpendLimitsServiceShape,
} from "./services/SpendLimitsService"

// ---------------------------------------------------------------------------
// Hourly spend-limit evaluation.
//
// Turns configuration into enforcement: for every org that has set a ceiling or
// a cap, price the cycle from Autumn and stamp the result on `org_spend_limits`,
// where the ingest gateway reads it as a single boolean per request. Pricing in
// the gateway's hot path is not an option — it resolves keys from Postgres with
// no Autumn client at all — so this cron is the only thing standing between a
// configured limit and a 402.
//
// The work-list is deliberately narrow: only orgs with a configured ceiling or
// cap (SpendLimitsService.listConfigured filters the rest), because each entry
// costs two Autumn round-trips per tick. An org that never opened the card costs
// nothing.
// ---------------------------------------------------------------------------

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

export const buildSpendLimitLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))
	const DatabaseLive = layerPg.pipe(Layer.provide(WorkerEnvironment.layer))
	const EdgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const SpendLimitsLive = SpendLimitsService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, DatabaseLive)),
	)

	return Layer.mergeAll(SpendLimitsLive, EnvLive, EdgeCacheLive).pipe(
		Layer.provideMerge(WorkerEnvironment.layer),
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(ConfigLive),
	)
}

export const flushSpendLimitTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

const METERED_FEATURE_IDS = ["logs", "traces", "metrics", "browser_sessions"]

/**
 * Evaluate one org. Failures are contained here — a single org's Autumn hiccup
 * must not abandon the rest of the work-list, and it must not pause anyone:
 * without a fresh spend number we leave the previous state exactly as it was.
 */
export const evaluateOrg = Effect.fn("SpendLimitEvaluation.evaluateOrg")(function* (
	entry: ConfiguredSpendLimits,
	deps: {
		readonly callAutumn: ReturnType<typeof makeCallAutumn>
		readonly edgeCache: Pick<EdgeCacheServiceShape, "getOrCompute">
		readonly spendLimits: Pick<SpendLimitsServiceShape, "recordEvaluation">
	},
) {
	const orgId = decodeOrgId(entry.orgId)

	const { result } = yield* readCustomerCached(
		deps.edgeCache,
		entry.orgId,
		// Same expansion as the route: the evaluator must price a custom plan
		// with the customer's own rates, not the public catalog's.
		deps.callAutumn("getOrCreateCustomer", { expand: ["subscriptions.plan"] }, entry.orgId),
	)
	const customer = yield* decodeUpstream(BillingCustomer, yield* ensureOk(result))

	const plansResult = yield* deps.callAutumn("listPlans", {}, entry.orgId)
	const plansResponse = yield* ensureOk(plansResult)
	const plansList = (plansResponse as { list?: unknown })?.list ?? plansResponse
	const plans = yield* decodeUpstream(Schema.Array(CatalogPlan), plansList)

	const usageResult = yield* deps.callAutumn(
		"aggregateEvents",
		{ featureId: METERED_FEATURE_IDS, range: "1bc" },
		entry.orgId,
	)
	const usage = yield* decodeUpstream(BillingUsage, yield* ensureOk(usageResult))

	const nowMs = yield* Clock.currentTimeMillis
	const cycle = resolveCycleWindow(customer, nowMs)

	const evaluation = evaluateSpendLimits({
		limits: entry.limits,
		customer,
		plans,
		usage: usage.total,
		cycleStartMs: cycle.startMs,
		previousCycleStartMs: entry.cycleStartedAtMs,
		previouslyNotified: entry.notifiedThresholds,
	})

	// A lower-bound estimate must never pause a customer: we'd be cutting off
	// ingestion on a number we know is incomplete. That applies to per-feature
	// caps exactly as it does to the ceiling — `exceededCaps` becomes
	// `pausedFeatures` in the gateway, so letting it through on a partial
	// estimate would pause on the very number the line above refuses to act on.
	const trustworthy = !evaluation.partial
	const breached = evaluation.breached && trustworthy

	yield* deps.spendLimits.recordEvaluation(orgId, {
		spendCents: evaluation.spendCents,
		breached,
		cycleStartMs: cycle.startMs,
		// Delivery isn't wired yet (see below), so nothing has been notified.
		// Recording the crossings as notified would mean the first customer to
		// hit a limit gets no warning at all: when delivery lands, every
		// threshold already stamped this cycle is skipped forever. Stay empty
		// until something actually sends — the crossing then re-detects each
		// tick and fires once.
		notifiedThresholds: [],
		exceededCaps: trustworthy ? evaluation.exceededCaps : [],
	})

	yield* Effect.annotateCurrentSpan({
		orgId: entry.orgId,
		"billing.spend_cents": evaluation.spendCents,
		"billing.limit_cents": entry.limits.monthlyLimitCents ?? 0,
		"billing.breached": breached,
		"billing.partial": evaluation.partial,
		"billing.paused_features": (trustworthy ? evaluation.exceededCaps : []).join(","),
	})

	if (evaluation.newlyCrossedThresholds.length > 0) {
		// Delivery (Slack / email to billing admins) is not wired yet — the
		// existing NotificationDispatcher speaks alert-rule payloads and a spend
		// alert needs its own. Until it exists this log is the only signal, and
		// it repeats every tick by design: nothing is stamped as notified, so
		// the day delivery lands it fires for orgs already over their threshold
		// instead of silently skipping them.
		yield* Effect.logWarning("Spend limit threshold crossed").pipe(
			Effect.annotateLogs({
				orgId: entry.orgId,
				thresholds: evaluation.newlyCrossedThresholds,
				spendCents: evaluation.spendCents,
				limitCents: entry.limits.monthlyLimitCents,
				enforcementMode: entry.limits.enforcementMode,
			}),
		)
	}

	if (breached) {
		yield* Effect.logWarning("Spend limit breached").pipe(
			Effect.annotateLogs({
				orgId: entry.orgId,
				spendCents: evaluation.spendCents,
				limitCents: entry.limits.monthlyLimitCents,
				paused: entry.limits.enforcementMode === "pause",
			}),
		)
	}

	return { evaluated: true, breached }
})

export const runSpendLimitEvaluation = Effect.gen(function* () {
	const env = yield* Env
	const edgeCache = yield* EdgeCacheService
	const spendLimits = yield* SpendLimitsService

	const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
		onNone: () => undefined,
		onSome: (value) => Redacted.value(value),
	})
	if (secretKey === undefined) {
		// Self-hosted / local: no billing provider, so no spend to evaluate. Not an
		// error — just nothing to do.
		yield* Effect.logDebug("Spend limit evaluation skipped: billing is not configured")
		return
	}

	const callAutumn = makeCallAutumn(secretKey)
	const configured = yield* spendLimits.listConfigured()

	let evaluated = 0
	let breached = 0
	let failed = 0

	for (const entry of configured) {
		const outcome = yield* evaluateOrg(entry, { callAutumn, edgeCache, spendLimits }).pipe(
			Effect.catchCause((cause) =>
				Effect.logError("Spend limit evaluation failed for org")
					.pipe(Effect.annotateLogs({ orgId: entry.orgId, cause }))
					.pipe(Effect.as({ evaluated: false, breached: false })),
			),
		)
		if (!outcome.evaluated) failed += 1
		else {
			evaluated += 1
			if (outcome.breached) breached += 1
		}
	}

	yield* Effect.annotateCurrentSpan({
		"billing.orgs_configured": configured.length,
		"billing.orgs_evaluated": evaluated,
		"billing.orgs_breached": breached,
		"billing.orgs_failed": failed,
	})
}).pipe(Effect.withSpan("SpendLimitEvaluation.run"))
