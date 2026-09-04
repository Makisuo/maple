/**
 * Fixture rows for `/lab/errors`.
 *
 * Built as `ErrorSignal`s — the joined object a row actually renders — rather
 * than as three fetch payloads, because the join is already covered by
 * `error-signal.test.ts` and what the lab is for is the rendering. The issue
 * documents underneath are decoded through the real `ErrorIssueDocument`
 * schema, so a fixture cannot drift from the wire format and pass unnoticed.
 *
 * Everything is a pure function of `nowMs`: the window is relative so
 * "last seen" reads the way it does in the product, and every count and
 * sparkline is deterministic so a visual change is the only thing that ever
 * moves between two runs.
 */
import { Schema } from "effect"

import {
	ErrorIssueDocument,
	type IssueKind,
	type IssueSeverity,
	type WorkflowState,
} from "@maple/domain/http"

import type { ErrorSignal, InvestigationSummary } from "@/lib/models/error-signal"

// The whole document decodes in one go, nested actor included, so no fixture
// value is ever branded by hand.
const decodeIssue = Schema.decodeUnknownSync(ErrorIssueDocument)

/** 12 hours, the errors page's own default preset. */
export const LAB_WINDOW_MS = 12 * 60 * 60 * 1000
/** Matches `SPARK_BUCKETS` in the hub, so the lab's sparklines have the density
 *  the real page draws at 12h. */
const SPARK_BUCKETS = 32

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/** An actor as it arrives on the wire — decoded as part of the issue below. */
interface ActorSeed {
	readonly id: number
	readonly type: "user" | "agent"
	readonly agentName?: string
	readonly model?: string
}

function actor(seed: ActorSeed): Record<string, unknown> {
	return {
		id: uuid(900 + seed.id),
		type: seed.type,
		userId: seed.type === "user" ? uuid(800 + seed.id) : null,
		agentName: seed.agentName ?? null,
		model: seed.model ?? null,
		capabilities: [],
		lastActiveAt: null,
	}
}

const ASHA = actor({ id: 1, type: "user" })
const REN = actor({ id: 2, type: "user" })
const MAPLE_AGENT = actor({ id: 3, type: "agent", agentName: "maple-triage", model: "claude-opus" })

/** Bucket shapes, as a fraction of the row's total. Named for what a triaging
 *  human would call them, because that is what the sparkline has to convey. */
type TrendPattern = "steady" | "surging" | "spiky" | "decaying" | "burst" | "silent"

function patternWeight(pattern: TrendPattern, index: number, count: number): number {
	const t = count <= 1 ? 1 : index / (count - 1)
	switch (pattern) {
		case "steady":
			// Deterministic wobble, so it reads as real traffic rather than a bar.
			return 1 + 0.25 * Math.sin(index * 1.7)
		case "surging":
			return 0.15 + t ** 4 * 6
		case "spiky":
			return index % 7 === 3 ? 4 : 0.4
		case "decaying":
			return 0.1 + (1 - t) ** 3 * 4
		case "burst":
			return index === Math.floor(count * 0.62) ? 20 : 0.05
		case "silent":
			return 0
	}
}

function spark(
	pattern: TrendPattern,
	total: number,
	window: { startMs: number; bucketMs: number },
): ReadonlyArray<{ bucket: string; count: number }> {
	if (pattern === "silent" || total === 0) return []
	const weights = Array.from({ length: SPARK_BUCKETS }, (_, i) => patternWeight(pattern, i, SPARK_BUCKETS))
	const sum = weights.reduce((a, b) => a + b, 0)
	return weights.flatMap((weight, index) => {
		const count = Math.round((weight / sum) * total)
		// The warehouse emits no row for a quiet bucket, and `densifySpark` is what
		// puts the gap back — a fixture that filled them would never exercise it.
		if (count === 0) return []
		return [{ bucket: new Date(window.startMs + index * window.bucketMs).toISOString(), count }]
	})
}

interface SignalSeed {
	readonly n: number
	readonly title: string
	readonly detail: string
	readonly service: string
	readonly kind?: IssueKind
	readonly severity: IssueSeverity | null
	readonly state: WorkflowState
	readonly pattern: TrendPattern
	/** `null` is a fingerprint with nothing in the window — an issue gone quiet. */
	readonly windowCount: number | null
	readonly totalCount: number
	readonly lastSeenMinutesAgo: number
	readonly firstSeenDaysAgo: number
	readonly assignee?: Record<string, unknown>
	readonly incident?: boolean
	readonly investigation?: InvestigationSummary
	readonly comments?: number
	readonly openPrs?: number
	readonly mergedPrs?: number
	readonly regressionCount?: number
}

const SEEDS: ReadonlyArray<SignalSeed> = [
	{
		n: 1,
		title: "TypeError",
		detail: "Cannot read properties of undefined (reading 'subscription')",
		service: "web",
		severity: "critical",
		state: "triage",
		pattern: "surging",
		windowCount: 12_408,
		totalCount: 41_772,
		lastSeenMinutesAgo: 0,
		firstSeenDaysAgo: 2,
		incident: true,
	},
	{
		n: 2,
		title: "PaymentDeclinedError",
		detail: "card_declined: insufficient_funds",
		service: "billing",
		severity: "high",
		state: "in_progress",
		pattern: "steady",
		windowCount: 3_190,
		totalCount: 28_004,
		lastSeenMinutesAgo: 2,
		firstSeenDaysAgo: 31,
		assignee: MAPLE_AGENT,
		investigation: { id: uuid(701), status: "investigating", confidence: null },
		comments: 2,
	},
	{
		n: 3,
		title: "ConnectTimeoutError",
		detail: "Hyperdrive connect timed out after 5000ms",
		service: "api",
		severity: "high",
		state: "in_review",
		pattern: "spiky",
		windowCount: 884,
		totalCount: 9_120,
		lastSeenMinutesAgo: 11,
		firstSeenDaysAgo: 9,
		assignee: ASHA,
		investigation: { id: uuid(702), status: "diagnosed", confidence: "high" },
		comments: 7,
		openPrs: 1,
	},
	{
		n: 4,
		title: "PrismaClientKnownRequestError",
		detail: "Invalid `prisma.organizationMember.findUnique()` invocation: Timed out fetching a new connection from the connection pool. More info: http://pris.ly/d/connection-pool (Current connection pool timeout: 10, connection limit: 5)",
		service: "api",
		severity: "medium",
		state: "todo",
		pattern: "decaying",
		windowCount: 612,
		totalCount: 4_301,
		lastSeenMinutesAgo: 26,
		firstSeenDaysAgo: 4,
		assignee: REN,
		comments: 1,
	},
	{
		n: 5,
		title: "UnhandledPromiseRejection",
		detail: "AbortError: The operation was aborted",
		service: "ingest",
		severity: "medium",
		state: "regressed",
		pattern: "burst",
		windowCount: 448,
		totalCount: 15_882,
		lastSeenMinutesAgo: 41,
		firstSeenDaysAgo: 74,
		comments: 12,
		mergedPrs: 2,
		regressionCount: 3,
	},
	{
		n: 6,
		title: "ChunkLoadError",
		detail: "Loading chunk 4821 failed. (missing: /assets/dashboard-Bq1x.js)",
		service: "web",
		severity: null,
		state: "todo",
		pattern: "spiky",
		windowCount: 204,
		totalCount: 1_940,
		lastSeenMinutesAgo: 58,
		firstSeenDaysAgo: 12,
	},
	{
		n: 7,
		title: "ClickHouseError",
		detail: "Memory limit (for query) exceeded: would use 9.31 GiB",
		service: "query-engine",
		severity: null,
		state: "triage",
		pattern: "steady",
		windowCount: 96,
		totalCount: 96,
		lastSeenMinutesAgo: 7,
		firstSeenDaysAgo: 0,
	},
	{
		n: 8,
		title: "alert.error_rate.breached",
		detail: "checkout-api error rate above 5% for 10m",
		service: "alerting",
		kind: "alert",
		severity: "high",
		state: "triage",
		pattern: "silent",
		windowCount: null,
		totalCount: 22,
		lastSeenMinutesAgo: 96,
		firstSeenDaysAgo: 5,
	},
	{
		n: 9,
		title: "RateLimitExceeded",
		detail: "429 from api.stripe.com — retry after 4s",
		service: "billing",
		severity: null,
		state: "wontfix",
		pattern: "steady",
		windowCount: 61,
		totalCount: 8_004,
		lastSeenMinutesAgo: 33,
		firstSeenDaysAgo: 120,
		comments: 3,
	},
	{
		n: 10,
		title: "SessionReplayChunkCorruption",
		detail: "rrweb chunk failed to inflate: incorrect header check",
		service: "web",
		severity: "medium",
		state: "done",
		pattern: "silent",
		windowCount: null,
		totalCount: 3_610,
		lastSeenMinutesAgo: 60 * 24 * 6,
		firstSeenDaysAgo: 40,
		assignee: ASHA,
		comments: 9,
		mergedPrs: 1,
	},
	{
		n: 11,
		title: "OtlpExportFailed",
		detail: "grpc status 14: unavailable",
		service: "ingest",
		severity: null,
		state: "cancelled",
		pattern: "decaying",
		windowCount: 18,
		totalCount: 512,
		lastSeenMinutesAgo: 60 * 5,
		firstSeenDaysAgo: 18,
	},
	{
		n: 12,
		title: "InvalidFingerprintHashDecodeError",
		detail: "toUInt64 parse failed for 'planetscale:maple-prd:branch.out_of_memory'",
		service: "alerting",
		kind: "integration",
		severity: "critical",
		state: "in_progress",
		pattern: "surging",
		windowCount: 1_764,
		totalCount: 1_764,
		lastSeenMinutesAgo: 1,
		firstSeenDaysAgo: 0,
		assignee: MAPLE_AGENT,
		investigation: { id: uuid(703), status: "inconclusive", confidence: "low" },
	},
]

function issueOf(seed: SignalSeed, nowMs: number): ErrorIssueDocument {
	const lastSeen = new Date(nowMs - seed.lastSeenMinutesAgo * 60_000).toISOString()
	return decodeIssue({
		id: uuid(seed.n),
		kind: seed.kind ?? "error",
		fingerprintHash: String(1_000_000_000_000_000 + seed.n * 7_919),
		serviceName: seed.service,
		exceptionType: seed.title,
		exceptionMessage: seed.detail,
		errorLabel: seed.title,
		topFrame: `at handler (src/${seed.service}/index.ts:${40 + seed.n})`,
		workflowState: seed.state,
		priority: seed.n,
		severity: seed.severity,
		severitySource: seed.severity === null ? null : "detector",
		sourceRef: null,
		assignedActor: seed.assignee ?? null,
		leaseHolder: null,
		leaseExpiresAt: null,
		claimedAt: null,
		notes: null,
		firstSeenAt: new Date(nowMs - seed.firstSeenDaysAgo * 86_400_000).toISOString(),
		lastSeenAt: lastSeen,
		occurrenceCount: seed.totalCount,
		resolvedAt: seed.state === "done" ? lastSeen : null,
		lastResolvedAt: seed.regressionCount ? new Date(nowMs - 9 * 86_400_000).toISOString() : null,
		lastRegressedAt: seed.regressionCount ? new Date(nowMs - 2 * 86_400_000).toISOString() : null,
		regressionCount: seed.regressionCount ?? 0,
		resolvedVersions: [],
		snoozeUntil: null,
		archivedAt: null,
		hasOpenIncident: seed.incident ?? false,
		commentCount: seed.comments ?? 0,
		openPullRequestCount: seed.openPrs ?? 0,
		mergedPullRequestCount: seed.mergedPrs ?? 0,
	})
}

export interface ErrorsLabFixture {
	readonly signals: ReadonlyArray<ErrorSignal>
	readonly sparkWindow: { readonly startMs: number; readonly endMs: number; readonly bucketMs: number }
	/** What the stat strip would say for this window, so the lab renders the
	 *  page's full chrome rather than a list floating on its own. */
	readonly summary: {
		readonly totalErrors: number
		readonly errorRate: number
		readonly affectedServicesCount: number
		readonly affectedTracesCount: number
	}
}

export function buildErrorsLabFixture(nowMs: number): ErrorsLabFixture {
	const endMs = nowMs
	const startMs = endMs - LAB_WINDOW_MS
	const bucketMs = LAB_WINDOW_MS / SPARK_BUCKETS
	const window = { startMs, endMs, bucketMs }

	const signals = SEEDS.map((seed): ErrorSignal => {
		const issue = issueOf(seed, nowMs)
		return {
			id: issue.id,
			fingerprintHash: issue.fingerprintHash,
			title: issue.exceptionType,
			detail: issue.exceptionMessage,
			serviceName: issue.serviceName,
			severity: issue.severity,
			investigation: seed.investigation ?? null,
			windowCount: seed.windowCount,
			totalCount: seed.totalCount,
			affectedServicesCount: seed.windowCount === null ? null : 1 + (seed.n % 3),
			spark: spark(seed.pattern, seed.windowCount ?? 0, window),
			lastSeenAt: issue.lastSeenAt,
			firstSeenAt: issue.firstSeenAt,
			assignee: issue.leaseHolder ?? issue.assignedActor,
			commentCount: issue.commentCount,
			openPullRequestCount: issue.openPullRequestCount,
			mergedPullRequestCount: issue.mergedPullRequestCount,
			issue,
		}
	})

	const totalErrors = signals.reduce((sum, signal) => sum + (signal.windowCount ?? 0), 0)
	return {
		signals,
		sparkWindow: window,
		summary: {
			totalErrors,
			errorRate: 0.0214,
			affectedServicesCount: new Set(signals.map((signal) => signal.serviceName)).size,
			affectedTracesCount: Math.round(totalErrors * 0.72),
		},
	}
}
