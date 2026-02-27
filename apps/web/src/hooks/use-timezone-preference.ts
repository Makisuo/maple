import { useAtom } from "@effect-atom/atom-react"
import { useCallback, useEffect, useMemo } from "react"
import {
  getBrowserTimeZone,
  isValidIanaTimeZone,
  normalizeStoredTimezoneValue,
  resolveEffectiveTimezone,
  SYSTEM_VALUE,
  TIMEZONE_STORAGE_KEY,
  timezonePreferenceAtom,
} from "@/atoms/timezone-preference-atoms"

function listSupportedTimeZones(): string[] {
  const fallback = Array.from(new Set(["UTC", getBrowserTimeZone()]))

  if (typeof Intl.supportedValuesOf !== "function") {
    return fallback
  }

  try {
    const values = Intl.supportedValuesOf("timeZone")
    return values.length > 0 ? values : fallback
  } catch {
    return fallback
  }
}

export function useTimezonePreference() {
  const [storedTimezone, setStoredTimezone] = useAtom(timezonePreferenceAtom)

  const selectedTimezone = useMemo(
    () =>
      storedTimezone === SYSTEM_VALUE || !isValidIanaTimeZone(storedTimezone)
        ? null
        : storedTimezone,
    [storedTimezone],
  )

  const effectiveTimezone = useMemo(
    () => resolveEffectiveTimezone(storedTimezone),
    [storedTimezone],
  )

  const setSelectedTimezone = useCallback(
    (next: string | null) => {
      setStoredTimezone(normalizeStoredTimezoneValue(next))
    },
    [setStoredTimezone],
  )

  const supportedTimezones = useMemo(() => listSupportedTimeZones(), [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== TIMEZONE_STORAGE_KEY) return
      setStoredTimezone(normalizeStoredTimezoneValue(event.newValue))
    }

    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener("storage", onStorage)
    }
  }, [setStoredTimezone])

  return {
    selectedTimezone,
    effectiveTimezone,
    setSelectedTimezone,
    supportedTimezones,
  }
}
