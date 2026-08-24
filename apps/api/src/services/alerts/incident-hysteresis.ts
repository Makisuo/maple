import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

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
