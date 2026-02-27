import { getBrowserTimeZone, isValidIanaTimeZone } from "@/atoms/timezone-preference-atoms"

type TimezoneFormatInput = string | number | Date

const TINYBIRD_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/

function normalizeTimestampInput(value: string): string {
  const trimmed = value.trim()
  const match = TINYBIRD_UTC_PATTERN.exec(trimmed)
  if (!match) {
    return trimmed
  }

  const [, date, time, fractional] = match
  if (!fractional) {
    return `${date}T${time}Z`
  }

  const milliseconds = `${fractional}000`.slice(0, 3)
  return `${date}T${time}.${milliseconds}Z`
}

function toValidDate(input: TimezoneFormatInput): Date | null {
  const normalized =
    typeof input === "string"
      ? normalizeTimestampInput(input)
      : input

  const date = normalized instanceof Date ? normalized : new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function resolveTimeZone(timeZone: string): string {
  return isValidIanaTimeZone(timeZone) ? timeZone : getBrowserTimeZone()
}

export function formatTimestampInTimezone(
  input: TimezoneFormatInput,
  options: { timeZone: string; withMilliseconds?: boolean },
): string {
  const date = toValidDate(input)
  if (!date) return "-"

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(options.timeZone),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: options.withMilliseconds ? 3 : undefined,
  })

  return formatter.format(date)
}

export function formatTimeInTimezone(
  input: TimezoneFormatInput,
  options: { timeZone: string; withSeconds?: boolean },
): string {
  const date = toValidDate(input)
  if (!date) return "-"

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(options.timeZone),
    hour: "2-digit",
    minute: "2-digit",
    second: options.withSeconds ? "2-digit" : undefined,
  })

  return formatter.format(date)
}
