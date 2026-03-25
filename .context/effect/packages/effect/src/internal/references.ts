import type { ErrorReporter } from "../ErrorReporter.ts"
import { constTrue, constUndefined } from "../Function.ts"
import type { LogLevel, Severity } from "../LogLevel.ts"
import type { ReadonlyRecord } from "../Record.ts"
import type { StackFrame } from "../References.ts"
import * as ServiceMap from "../ServiceMap.ts"
import type { SpanLink } from "../Tracer.ts"

/** @internal */
export const CurrentConcurrency = ServiceMap.Reference<"unbounded" | number>("effect/References/CurrentConcurrency", {
  defaultValue: () => "unbounded"
})

/** @internal */
export const CurrentErrorReporters = ServiceMap.Reference<ReadonlySet<ErrorReporter>>(
  "effect/ErrorReporter/CurrentErrorReporters",
  { defaultValue: () => new Set() }
)

/** @internal */
export const CurrentStackFrame = ServiceMap.Reference<StackFrame | undefined>("effect/References/CurrentStackFrame", {
  defaultValue: constUndefined
})

/** @internal */
export const TracerEnabled = ServiceMap.Reference<boolean>("effect/References/TracerEnabled", {
  defaultValue: constTrue
})

/** @internal */
export const TracerTimingEnabled = ServiceMap.Reference<boolean>("effect/References/TracerTimingEnabled", {
  defaultValue: constTrue
})

/** @internal */
export const TracerSpanAnnotations = ServiceMap.Reference<ReadonlyRecord<string, unknown>>(
  "effect/References/TracerSpanAnnotations",
  { defaultValue: () => ({}) }
)

/** @internal */
export const TracerSpanLinks = ServiceMap.Reference<ReadonlyArray<SpanLink>>("effect/References/TracerSpanLinks", {
  defaultValue: () => []
})

/** @internal */
export const CurrentLogAnnotations = ServiceMap.Reference<ReadonlyRecord<string, unknown>>(
  "effect/References/CurrentLogAnnotations",
  { defaultValue: () => ({}) }
)

/** @internal */
export const CurrentLogLevel: ServiceMap.Reference<Severity> = ServiceMap.Reference<Severity>(
  "effect/References/CurrentLogLevel",
  { defaultValue: () => "Info" }
)

/** @internal */
export const MinimumLogLevel = ServiceMap.Reference<
  LogLevel
>("effect/References/MinimumLogLevel", { defaultValue: () => "Info" })

/** @internal */
export const UnhandledLogLevel: ServiceMap.Reference<Severity | undefined> = ServiceMap.Reference(
  "effect/References/UnhandledLogLevel",
  { defaultValue: (): Severity | undefined => "Error" }
)

/** @internal */
export const CurrentLogSpans = ServiceMap.Reference<
  ReadonlyArray<[label: string, timestamp: number]>
>("effect/References/CurrentLogSpans", { defaultValue: () => [] })
