// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OrgTinybirdSettingsSection } from "./org-tinybird-settings-section"

type MockResult =
  | { readonly _tag: "initial" }
  | { readonly _tag: "success"; readonly value: unknown }
  | { readonly _tag: "failure" }

const mocks = vi.hoisted(() => ({
  refreshSpy: vi.fn(),
  upsertSpy: vi.fn(),
  resyncSpy: vi.fn(),
  deleteSpy: vi.fn(),
  toastSuccessSpy: vi.fn(),
  toastErrorSpy: vi.fn(),
  settingsResult: { _tag: "initial" } as MockResult,
}))

vi.mock("@/lib/services/common/atom-client", () => ({
  MapleApiAtomClient: {
    query: (_group: string, name: string) => ({ kind: "query", name }),
    mutation: (_group: string, name: string) => ({ kind: "mutation", name }),
  },
}))

vi.mock("@effect-atom/atom-react", () => ({
  Result: {
    builder: (result: MockResult) => ({
      onSuccess: (onSuccess: (value: unknown) => unknown) => ({
        orElse: (onElse: () => unknown) => (result._tag === "success" ? onSuccess(result.value) : onElse()),
      }),
    }),
    isInitial: (result: MockResult) => result._tag === "initial",
    isSuccess: (result: MockResult) => result._tag === "success",
  },
  useAtomRefresh: () => mocks.refreshSpy,
  useAtomSet: (descriptor: { readonly name: string }) => {
    if (descriptor.name === "upsert") return mocks.upsertSpy
    if (descriptor.name === "resync") return mocks.resyncSpy
    if (descriptor.name === "delete") return mocks.deleteSpy
    throw new Error(`Unexpected mutation ${descriptor.name}`)
  },
  useAtomValue: () => mocks.settingsResult,
}))

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessSpy,
    error: mocks.toastErrorSpy,
  },
}))

describe("OrgTinybirdSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settingsResult = {
      _tag: "success",
      value: {
        configured: true,
        host: "https://customer.tinybird.co",
        syncStatus: "active",
        lastSyncAt: "2026-03-13T10:00:00.000Z",
        lastSyncError: null,
        projectRevision: "rev-1",
      },
    }
    mocks.upsertSpy.mockResolvedValue(Exit.succeed({}))
    mocks.resyncSpy.mockResolvedValue(Exit.succeed({}))
    mocks.deleteSpy.mockResolvedValue(Exit.succeed({}))
  })

  afterEach(() => {
    cleanup()
  })

  it("renders the out_of_sync badge and guidance", () => {
    mocks.settingsResult = {
      _tag: "success",
      value: {
        configured: true,
        host: "https://customer.tinybird.co",
        syncStatus: "out_of_sync",
        lastSyncAt: "2026-03-13T10:00:00.000Z",
        lastSyncError: null,
        projectRevision: "rev-1",
      },
    }

    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />)

    expect(screen.getByText("Out of sync")).toBeTruthy()
    expect(screen.getByText(/project definition changed since this org last synced/i)).toBeTruthy()
  })

  it("resyncs explicitly from the settings screen", async () => {
    render(<OrgTinybirdSettingsSection isAdmin hasEntitlement />)

    fireEvent.click(screen.getByRole("button", { name: "Resync project" }))

    await waitFor(() => {
      expect(mocks.resyncSpy).toHaveBeenCalledWith({})
    })
    expect(mocks.refreshSpy).toHaveBeenCalled()
    expect(mocks.toastSuccessSpy).toHaveBeenCalledWith("Tinybird project synced")
    expect(mocks.toastErrorSpy).not.toHaveBeenCalled()
  })

  it("renders nothing when the org lacks the BYO entitlement", () => {
    const { container } = render(<OrgTinybirdSettingsSection isAdmin hasEntitlement={false} />)

    expect(container.firstChild).toBeNull()
  })
})
