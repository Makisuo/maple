import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

/**
 * THE breach/recovery hysteresis shared by the two incident paths.
 *
 * `advanceAlertCounters` (user-configured rules) and `decideTransition` (the
 * zero-config anomaly detector) were the same mechanic spelled twice: breach on
 * N consecutive ticks to open, be healthy on M consecutive ticks to resolve.
 * The anomaly copy additionally guards re-opening with a cooldown. They agreed
 * only by luck, which is the shape of divergence that survives review.
 *
 * Planned, never started: every caller is a cron tick holding a Postgres row,
 * so `Machine.plan` folds one observation into one snapshot with no runtime,
 * no fibers, and no timers. Wall time arrives on the event because a tick knows
 * `now` and the planner does not.
 */

const HysteresisConfig = Schema.Struct({
	/** Consecutive breaching ticks before an incident opens. */
	breachesToOpen: Schema.Number,
	/** Consecutive healthy ticks before an open incident resolves. */
	healthyToResolve: Schema.Number,
	/** Quiet period after a resolve during which re-opening is suppressed. 0 disables it. */
	cooldownMs: Schema.Number,
})
export type HysteresisConfig = Schema.Schema.Type<typeof HysteresisConfig>

/**
 * Counters saturate at their requirement because they are only ever compared
 * with `>=`. That keeps open/resolve behaviour identical while letting a
 * steady-state tick recognise its state as unchanged and skip the row upsert.
 */
export const HysteresisStates = Machine.states({
	Clear: Schema.TaggedStruct("Clear", {
		consecutiveHealthy: Schema.Number,
		/** Set only while a post-resolve cooldown is still running. */
		cooldownUntilMs: Schema.NullOr(Schema.Number),
	}),
	Breaching: Schema.TaggedStruct("Breaching", {
		consecutiveBreaches: Schema.Number,
		cooldownUntilMs: Schema.NullOr(Schema.Number),
	}),
	Open: Schema.TaggedStruct("Open", {
		consecutiveBreaches: Schema.Number,
		consecutiveHealthy: Schema.Number,
	}),
})

/** One evaluated window, in the order the scheduler saw it. */
export const HysteresisEvent = Machine.events(
	Schema.TaggedUnion({
		Breached: { nowMs: Schema.Number, config: HysteresisConfig },
		Recovered: { nowMs: Schema.Number, config: HysteresisConfig },
		/** Too few samples to judge: evidence of nothing, in either direction. */
		Skipped: {},
	}),
)

export const HysteresisEmit = Machine.emittedEvents(
	Schema.TaggedUnion({
		IncidentOpened: { atMs: Schema.Number },
		IncidentResolved: { atMs: Schema.Number },
	}),
)

const definition = Machine.make({
	id: "IncidentHysteresis",
	states: HysteresisStates.states,
	events: HysteresisEvent,
	emittedEvents: HysteresisEmit,
	initial: (to) =>
		to.Clear().resolve(({ target }) => target.from({ consecutiveHealthy: 0, cooldownUntilMs: null })),
})

/** Whether a cooldown recorded at `untilMs` is still suppressing re-opens at `nowMs`. */
const cooling = (untilMs: number | null, nowMs: number): boolean => untilMs !== null && nowMs < untilMs

/** A cooldown that has elapsed is dropped so the row stops carrying dead weight. */
const carryCooldown = (untilMs: number | null, nowMs: number): number | null =>
	cooling(untilMs, nowMs) ? untilMs : null

export const IncidentHysteresis = definition.handle({
	Clear: {
		on: {
			Breached: (to) =>
				to
					.branches({
						breaching: { target: to.full.Breaching(), title: "still below the open threshold" },
						opened: { target: to.full.Open(), title: "threshold met" },
					})
					.resolve(({ state, event, select }, enqueue) => {
						const consecutiveBreaches = Math.min(1, event.config.breachesToOpen)
						if (
							consecutiveBreaches >= event.config.breachesToOpen &&
							!cooling(state.cooldownUntilMs, event.nowMs)
						) {
							enqueue.emit(HysteresisEmit.IncidentOpened({ atMs: event.nowMs }))
							return select.opened.from({ consecutiveBreaches, consecutiveHealthy: 0 })
						}
						return select.breaching.from({
							consecutiveBreaches,
							cooldownUntilMs: carryCooldown(state.cooldownUntilMs, event.nowMs),
						})
					}),
			Recovered: (to) =>
				to.full.Clear().resolve(({ state, event, target }) =>
					target.from({
						consecutiveHealthy: Math.min(
							state.consecutiveHealthy + 1,
							event.config.healthyToResolve,
						),
						cooldownUntilMs: carryCooldown(state.cooldownUntilMs, event.nowMs),
					}),
				),
			Skipped: (to) => to.none,
		},
	},
	Breaching: {
		on: {
			Breached: (to) =>
				to
					.branches({
						breaching: { target: to.full.Breaching(), title: "still below the open threshold" },
						opened: { target: to.full.Open(), title: "threshold met" },
					})
					.resolve(({ state, event, select }, enqueue) => {
						const consecutiveBreaches = Math.min(
							state.consecutiveBreaches + 1,
							event.config.breachesToOpen,
						)
						if (
							consecutiveBreaches >= event.config.breachesToOpen &&
							!cooling(state.cooldownUntilMs, event.nowMs)
						) {
							enqueue.emit(HysteresisEmit.IncidentOpened({ atMs: event.nowMs }))
							return select.opened.from({ consecutiveBreaches, consecutiveHealthy: 0 })
						}
						return select.breaching.from({
							consecutiveBreaches,
							cooldownUntilMs: carryCooldown(state.cooldownUntilMs, event.nowMs),
						})
					}),
			Recovered: (to) =>
				to.full.Clear().resolve(({ state, event, target }) =>
					target.from({
						consecutiveHealthy: Math.min(1, event.config.healthyToResolve),
						cooldownUntilMs: carryCooldown(state.cooldownUntilMs, event.nowMs),
					}),
				),
			Skipped: (to) => to.none,
		},
	},
	Open: {
		on: {
			Breached: (to) =>
				to.full.Open().resolve(({ state, event, target }) =>
					target.from({
						consecutiveBreaches: Math.min(
							state.consecutiveBreaches + 1,
							event.config.breachesToOpen,
						),
						consecutiveHealthy: 0,
					}),
				),
			Recovered: (to) =>
				to
					.branches({
						open: { target: to.full.Open(), title: "not healthy for long enough yet" },
						resolved: { target: to.full.Clear(), title: "recovery confirmed" },
					})
					.resolve(({ state, event, select }, enqueue) => {
						const consecutiveHealthy = Math.min(
							state.consecutiveHealthy + 1,
							event.config.healthyToResolve,
						)
						if (consecutiveHealthy < event.config.healthyToResolve) {
							// A healthy window clears the breach run even while the incident
							// stands: the run that opened it is over, and a later re-breach
							// starts counting from one.
							return select.open.from({ consecutiveBreaches: 0, consecutiveHealthy })
						}
						enqueue.emit(HysteresisEmit.IncidentResolved({ atMs: event.nowMs }))
						return select.resolved.from({
							consecutiveHealthy,
							cooldownUntilMs:
								event.config.cooldownMs > 0 ? event.nowMs + event.config.cooldownMs : null,
						})
					}),
			Skipped: (to) => to.none,
		},
	},
})

/**
 * The persisted shape both callers already store: `alert_rule_states` and
 * `anomaly_detector_states` keep counters plus whether an incident stands.
 *
 * The row stays the storage format and the machine stays the decision layer —
 * the snapshot is rebuilt from the row on every tick rather than persisted.
 * Incident *identity* (attach, reopen, the per-tick open budget) lives in the
 * services, so a plan that says "open" can still be deferred without the
 * machine and the world disagreeing about what is open.
 */
export interface HysteresisRow {
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
	readonly incidentOpen: boolean
	readonly lastResolvedAtMs: number | null
}

/** Same verdicts the two hand-rolled predecessors returned, to the letter. */
export interface HysteresisOutcome {
	readonly transition: "open" | "continue" | "resolve" | "noop"
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
}

type HysteresisSnapshot = Machine.Snapshot<typeof IncidentHysteresis>

/**
 * Rebuild the machine's view of a rule from its row.
 *
 * Goes through `decodeSnapshot` rather than asserting the shape: the encoded
 * form is the library's own persistence boundary, so a state renamed or a field
 * added above fails here with a schema error instead of silently planning from
 * a snapshot the machine never agreed to.
 */
const snapshotFrom = (
	row: HysteresisRow,
	config: HysteresisConfig,
): Effect.Effect<HysteresisSnapshot, Machine.MachineSchemaDecodeError> => {
	const cooldownUntilMs =
		row.lastResolvedAtMs !== null && config.cooldownMs > 0
			? row.lastResolvedAtMs + config.cooldownMs
			: null
	const active = row.incidentOpen
		? {
				path: "Open",
				value: {
					_tag: "Open",
					consecutiveBreaches: row.consecutiveBreaches,
					consecutiveHealthy: row.consecutiveHealthy,
				},
			}
		: row.consecutiveBreaches > 0
			? {
					path: "Breaching",
					value: {
						_tag: "Breaching",
						consecutiveBreaches: row.consecutiveBreaches,
						cooldownUntilMs,
					},
				}
			: {
					path: "Clear",
					value: {
						_tag: "Clear",
						consecutiveHealthy: row.consecutiveHealthy,
						cooldownUntilMs,
					},
				}
	return Machine.decodeSnapshot(IncidentHysteresis, { _tag: "MachineSnapshot", active: [active] })
}

/** The counters a snapshot implies, in the columns the rows actually have. */
export const countersOf = (
	snapshot: HysteresisSnapshot,
): { readonly consecutiveBreaches: number; readonly consecutiveHealthy: number } => {
	const value = snapshot.value
	switch (value._tag) {
		case "Clear":
			return { consecutiveBreaches: 0, consecutiveHealthy: value.consecutiveHealthy }
		case "Breaching":
			return { consecutiveBreaches: value.consecutiveBreaches, consecutiveHealthy: 0 }
		case "Open":
			return {
				consecutiveBreaches: value.consecutiveBreaches,
				consecutiveHealthy: value.consecutiveHealthy,
			}
	}
}

/**
 * Fold one evaluated window into the persisted counters and a verdict.
 *
 * `Machine.plan` is pure — no runtime, no fibers, no timers — which is what a
 * cron tick holding a row needs. Its failures (`InfiniteTransitionError`,
 * `MachineSchemaDecodeError`) can only mean the model above is wrong, never
 * that this observation was bad, so they die rather than widening every
 * caller's error channel with an impossibility.
 */
export const foldObservation = (
	row: HysteresisRow,
	status: "breached" | "healthy" | "skipped",
	config: HysteresisConfig,
	nowMs: number,
): Effect.Effect<HysteresisOutcome> =>
	Effect.gen(function* () {
		const snapshot = yield* snapshotFrom(row, config)
		const event =
			status === "skipped"
				? HysteresisEvent.Skipped()
				: status === "breached"
					? HysteresisEvent.Breached({ nowMs, config })
					: HysteresisEvent.Recovered({ nowMs, config })
		const planned = yield* Machine.plan(IncidentHysteresis, snapshot, event)
		const counters = countersOf(planned.next)
		const opened = planned.emittedEvents.some((e) => e._tag === "IncidentOpened")
		const resolved = planned.emittedEvents.some((e) => e._tag === "IncidentResolved")
		const transition: HysteresisOutcome["transition"] = opened
			? "open"
			: resolved
				? "resolve"
				: row.incidentOpen && status === "breached"
					? "continue"
					: "noop"
		return { transition, ...counters }
	}).pipe(Effect.orDie)
