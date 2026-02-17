import * as DateTime from "effect/DateTime"

const formatUtc = (dt: DateTime.DateTime): string =>
  DateTime.formatIso(dt).replace("T", " ").slice(0, 19)

export function defaultTimeRange(hours = 1) {
  const now = DateTime.unsafeNow()
  const start = DateTime.subtract(now, { hours })
  return {
    startTime: formatUtc(start),
    endTime: formatUtc(now),
  }
}
