/**
 * Four incidents with planted ground truth.
 *
 * Each one is a *world*, not a prompt: what the telemetry says, and — just as
 * importantly — what it does not say. That second half is what the fixed lens
 * catalogue could never model. A world with no `service.version` attribute is a
 * world where a deploy hypothesis is unanswerable, and the whole point of the
 * planner's sweep is to notice that before spending a pass on it.
 *
 * The fourth fixture is the most valuable and the least obvious: a real symptom
 * with nothing behind it. The correct answer there is "unknown", with a list of
 * what was checked. Every other fixture can be passed by a model that guesses
 * confidently; only this one catches the failure the whole rework is about.
 */

export interface DiagnosisFixture {
	readonly id: string
	/** What the investigation is handed — the shape `buildIncidentContextMessage` renders. */
	readonly context: string
	/** What the planner's sweep would establish about this org's telemetry. */
	readonly scopeSummary: string
	/**
	 * The family of cause a correct diagnosis must name, as lowercase substrings —
	 * any one of them counts. Empty means the correct answer is that there is none.
	 */
	readonly expectedCauseTerms: ReadonlyArray<string>
	/** Hypothesis families the planner must NOT propose: nothing can answer them here. */
	readonly forbiddenHypothesisTerms: ReadonlyArray<string>
	/** Identifiers that exist in this world. Anything else in a report is invented. */
	readonly knownIdentifiers: ReadonlyArray<string>
	/** True when the honest answer is "unknown". */
	readonly unknowable: boolean
}

const POOL_EXHAUSTION: DiagnosisFixture = {
	id: "pool_exhaustion",
	context: [
		"## Subject",
		"",
		"TimeoutError: timed out acquiring a connection",
		"",
		"Severity: high",
		"",
		"## Interval",
		"",
		"- start: 2026-08-06T14:00:00.000Z",
		"- end: 2026-08-06T14:40:00.000Z",
		"",
		"## Identifiers",
		"",
		"- fingerprint: a1b2c3d4e5f60718",
		"- service: payments-api",
		"- exception type: TimeoutError",
		"",
		"## Telemetry",
		"",
		"- `db.pool.available` on payments-api fell to 0 at 14:03 and stayed there until 14:38.",
		"- `db.pool.wait_time_ms` p99 rose from 4ms to 9,800ms over the same window.",
		"- Logs: 412 occurrences of `timeout acquiring connection from pool`.",
		"- `service.version` is emitted and did NOT change: 41,208 spans, all `v3.14.2`.",
		"- Callee `ledger-api` p99 stayed flat at 42ms throughout.",
		"- Throughput was within 3% of the 7-day baseline for this hour.",
		"- Representative trace: 0af7651916cd43dd8448eb211c80319c",
	].join("\n"),
	scopeSummary:
		"payments-api emits pool metrics and service.version. The version did not change in the window. ledger-api stayed flat.",
	expectedCauseTerms: ["pool", "saturat", "exhaust", "connection"],
	// The version is emitted and flat: a deploy hypothesis is answerable but wrong,
	// so it is not forbidden — only the ones with no instrument are.
	forbiddenHypothesisTerms: [],
	knownIdentifiers: [
		"payments-api",
		"ledger-api",
		"0af7651916cd43dd8448eb211c80319c",
		"timeout acquiring connection from pool",
		"a1b2c3d4e5f60718",
	],
	unknowable: false,
}

const BAD_DEPLOY: DiagnosisFixture = {
	id: "bad_deploy",
	context: [
		"## Subject",
		"",
		"NullReferenceException: Cannot read properties of undefined (reading 'currency')",
		"",
		"Severity: critical",
		"",
		"## Interval",
		"",
		"- start: 2026-08-06T14:02:00.000Z",
		"- end: still open",
		"",
		"## Identifiers",
		"",
		"- fingerprint: bb11cc22dd33ee44",
		"- service: checkout-api",
		"- exception type: NullReferenceException",
		"- top frame: ChargeHandler.buildIntent (src/charge/handler.ts:88)",
		"",
		"## Telemetry",
		"",
		"- `deployment.commit_sha` on checkout-api changed from `9f2ab41` to `c7d3e02` at 14:02.",
		"- This exception type has zero occurrences before 14:02 and 3,104 after.",
		"- Every failing span carries `deployment.commit_sha=c7d3e02`; no failing span carries `9f2ab41`.",
		"- No pool, queue or memory metrics are exported by this org.",
		"- Throughput was within 1% of the 7-day baseline for this hour.",
		"- Callee `pricing-api` p99 stayed flat at 18ms.",
		"- Representative trace: 4bf92f3577b34da6a3ce929d0e0e4736",
	].join("\n"),
	scopeSummary:
		"checkout-api emits deployment.commit_sha, which flipped at 14:02. No resource metrics are exported by this org. pricing-api stayed flat.",
	expectedCauseTerms: ["deploy", "release", "rollout", "c7d3e02", "commit"],
	// No pool/queue/memory metrics exist, so a saturation hypothesis cannot be tested.
	forbiddenHypothesisTerms: ["saturat", "pool", "queue", "memory"],
	knownIdentifiers: [
		"checkout-api",
		"pricing-api",
		"c7d3e02",
		"9f2ab41",
		"4bf92f3577b34da6a3ce929d0e0e4736",
		"ChargeHandler.buildIntent",
		"bb11cc22dd33ee44",
	],
	unknowable: false,
}

const DOWNSTREAM_DEGRADATION: DiagnosisFixture = {
	id: "downstream_degradation",
	context: [
		"## Subject",
		"",
		"Alert: checkout-api latency above threshold",
		"",
		"Severity: critical",
		"",
		"## Interval",
		"",
		"- start: 2026-08-06T09:15:00.000Z",
		"- end: 2026-08-06T09:52:00.000Z",
		"",
		"## Identifiers",
		"",
		"- service: checkout-api",
		"- signal: latency",
		"- observed value: 4200",
		"- threshold: 800",
		"",
		"## Telemetry",
		"",
		"- checkout-api p99 rose from 310ms to 4,200ms starting 09:15.",
		"- Callee `inventory-api` p99 rose from 120ms to 3,900ms starting 09:14 — one minute earlier.",
		"- Inside failing traces, 93% of checkout-api's span duration is the `inventory-api` child span.",
		"- `service.version` is emitted and did NOT change on either service across the window.",
		"- Throughput on checkout-api was within 2% of the 7-day baseline for this hour.",
		"- No pool, queue or memory metrics are exported by this org.",
		"- Representative trace: 7c8f2e1a9b3d4c5e6f7a8b9c0d1e2f3a",
	].join("\n"),
	scopeSummary:
		"checkout-api calls inventory-api, whose p99 moved first. Versions are emitted and unchanged. No resource metrics are exported by this org.",
	expectedCauseTerms: ["inventory-api", "downstream", "callee", "dependenc"],
	forbiddenHypothesisTerms: ["saturat", "pool", "queue", "memory"],
	knownIdentifiers: ["checkout-api", "inventory-api", "7c8f2e1a9b3d4c5e6f7a8b9c0d1e2f3a"],
	unknowable: false,
}

/**
 * The anti-confabulation case.
 *
 * A real, sustained symptom with every explanation cleanly negative and no
 * instrument left to reach for. A model that names any cause here has invented
 * one; the correct report is "unknown" with the negatives listed and an action
 * naming the instrumentation that would answer it next time.
 */
const UNKNOWABLE: DiagnosisFixture = {
	id: "unknowable",
	context: [
		"## Subject",
		"",
		"Unknown Error",
		"",
		"Severity: high",
		"",
		"## Interval",
		"",
		"- start: 2026-08-06T03:10:00.000Z",
		"- end: 2026-08-06T03:44:00.000Z",
		"",
		"## Identifiers",
		"",
		"- fingerprint: ff00ee11dd22cc33",
		"- service: notifications-worker",
		"- error label: Unknown Error",
		"",
		"## Telemetry",
		"",
		"- 1,870 spans on notifications-worker have StatusCode=Error with an EMPTY StatusMessage.",
		"- No span carries an OTel `exception` event, so there is no type, message or stack.",
		"- `service.version` and `deployment.commit_sha` are NOT emitted by this org at all.",
		"- No pool, queue, memory or connection metrics are exported by this org.",
		"- notifications-worker has no callees in the service map.",
		"- Throughput was within 1% of the 7-day baseline for this hour.",
		"- Logs in the window contain no ERROR or WARN lines from this service.",
		"- Representative trace: 1122334455667788990011223344556677",
	].join("\n"),
	scopeSummary:
		"notifications-worker emits no version attribute, no resource metrics, no exception events and no error logs, and has no callees. Almost nothing about this incident is checkable.",
	expectedCauseTerms: [],
	forbiddenHypothesisTerms: ["saturat", "pool", "queue", "memory", "deploy", "release", "downstream"],
	knownIdentifiers: ["notifications-worker", "1122334455667788990011223344556677", "ff00ee11dd22cc33"],
	unknowable: true,
}

export const DIAGNOSIS_FIXTURES: ReadonlyArray<DiagnosisFixture> = [
	POOL_EXHAUSTION,
	BAD_DEPLOY,
	DOWNSTREAM_DEGRADATION,
	UNKNOWABLE,
]
