import { Option } from "effect"

const pad = (n: number) => String(n).padStart(2, "0")

const formatDateTimeUTC = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

const parseSince = (since: string): number => {
  const match = since.match(/^(\d+)(m|h|d)$/)
  if (!match) throw new Error(`Invalid --since format: "${since}". Use e.g. 30m, 6h, 7d`)
  const [, num, unit] = match
  const n = Number(num)
  switch (unit) {
    case "m": return n * 60 * 1000
    case "h": return n * 60 * 60 * 1000
    case "d": return n * 24 * 60 * 60 * 1000
    default: throw new Error(`Unknown unit: ${unit}`)
  }
}

export const resolveTimeRange = (opts: {
  since: string
  start: Option.Option<string>
  end: Option.Option<string>
}): { startTime: string; endTime: string } => {
  if (Option.isSome(opts.start) && Option.isSome(opts.end)) {
    return { startTime: opts.start.value, endTime: opts.end.value }
  }

  const now = new Date()
  const endTime = Option.isSome(opts.end) ? opts.end.value : formatDateTimeUTC(now)
  const startMs = Option.isSome(opts.start)
    ? new Date(opts.start.value).getTime()
    : now.getTime() - parseSince(opts.since)

  const startTime = Option.isSome(opts.start)
    ? opts.start.value
    : formatDateTimeUTC(new Date(startMs))

  return { startTime, endTime }
}
