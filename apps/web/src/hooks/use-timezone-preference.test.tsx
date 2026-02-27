// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { Registry, RegistryContext } from "@effect-atom/atom-react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getBrowserTimeZone,
  TIMEZONE_STORAGE_KEY,
} from "@/atoms/timezone-preference-atoms"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"
import { useTimezonePreference } from "./use-timezone-preference"

function createWrapper() {
  const registry = Registry.make()
  registry.mount(localStorageRuntime)

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RegistryContext.Provider value={registry}>
        {children}
      </RegistryContext.Provider>
    )
  }
}

function Probe() {
  const { selectedTimezone, effectiveTimezone, setSelectedTimezone } =
    useTimezonePreference()

  return (
    <div>
      <div data-testid="selected">{selectedTimezone ?? "system"}</div>
      <div data-testid="effective">{effectiveTimezone}</div>
      <button onClick={() => setSelectedTimezone("UTC")}>set-utc</button>
    </div>
  )
}

describe("useTimezonePreference", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.removeItem(TIMEZONE_STORAGE_KEY)
  })

  afterEach(() => {
    cleanup()
  })

  it("initializes from system timezone when storage is empty", () => {
    render(<Probe />, { wrapper: createWrapper() })

    expect(screen.getByTestId("selected").textContent).toBe("system")
    expect(screen.getByTestId("effective").textContent).toBe(getBrowserTimeZone())
  })

  it("updates via hook setter", async () => {
    render(<Probe />, { wrapper: createWrapper() })

    fireEvent.click(screen.getByRole("button", { name: "set-utc" }))

    await waitFor(() => {
      expect(screen.getByTestId("selected").textContent).toBe("UTC")
    })
    expect(JSON.parse(window.localStorage.getItem(TIMEZONE_STORAGE_KEY) ?? "")).toBe("UTC")
  })

  it("reacts to storage events", async () => {
    render(<Probe />, { wrapper: createWrapper() })

    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, "America/Los_Angeles")
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: TIMEZONE_STORAGE_KEY,
        newValue: JSON.stringify("America/Los_Angeles"),
        storageArea: window.localStorage,
      }),
    )

    await waitFor(() => {
      expect(screen.getByTestId("selected").textContent).toBe(
        "America/Los_Angeles",
      )
    })
  })
})
