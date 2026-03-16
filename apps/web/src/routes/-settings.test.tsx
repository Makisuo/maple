// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type { Customer } from "autumn-js"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type MockResult =
  | { readonly _tag: "initial" }
  | { readonly _tag: "success"; readonly value: unknown }

const mocks = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  sessionResult: { _tag: "success", value: { roles: ["org:admin"] } } as MockResult,
  customer: null as Customer | null,
  isCustomerLoading: false,
  orgSectionProps: [] as Array<{ isAdmin: boolean; hasEntitlement: boolean }>,
  tabsValue: "",
}))

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")
  return {
    ...actual,
    useNavigate: () => mocks.navigateSpy,
  }
})

vi.mock("autumn-js/react", () => ({
  useCustomer: () => ({
    customer: mocks.customer,
    isLoading: mocks.isCustomerLoading,
  }),
}))

vi.mock("@effect-atom/atom-react", () => ({
  Result: {
    builder: (result: MockResult) => ({
      onSuccess: (onSuccess: (value: unknown) => unknown) => ({
        orElse: (onElse: () => unknown) => (result._tag === "success" ? onSuccess(result.value) : onElse()),
      }),
    }),
    isInitial: (result: MockResult) => result._tag === "initial",
  },
  useAtomValue: () => mocks.sessionResult,
}))

vi.mock("@/lib/services/common/atom-client", () => ({
  MapleApiAtomClient: {
    query: () => Symbol("session-query"),
  },
}))

vi.mock("@/lib/services/common/auth-mode", () => ({
  isClerkAuthEnabled: true,
}))

vi.mock("@/components/layout/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/settings/members-section", () => ({
  MembersSection: () => <div>members-section</div>,
}))

vi.mock("@/components/settings/billing-section", () => ({
  BillingSection: () => <div>billing-section</div>,
}))

vi.mock("@/components/settings/org-tinybird-settings-section", () => ({
  OrgTinybirdSettingsSection: (props: { isAdmin: boolean; hasEntitlement: boolean }) => {
    mocks.orgSectionProps.push(props)
    return <div>org-tinybird-settings-section</div>
  },
}))

vi.mock("@maple/ui/components/ui/tabs", () => ({
  Tabs: ({ value, children }: { value: string; children?: ReactNode }) => {
    mocks.tabsValue = value
    return <div>{children}</div>
  },
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  TabsContent: ({
    value,
    children,
  }: {
    value: string
    children?: ReactNode
  }) => (mocks.tabsValue === value ? <div>{children}</div> : null),
}))

import * as SettingsRoute from "./settings"

function buildCustomer(products: Customer["products"]): Customer {
  return {
    id: "cus_1",
    created_at: Date.now(),
    name: "Test",
    email: "test@maple.dev",
    fingerprint: null,
    stripe_id: null,
    env: "sandbox" as Customer["env"],
    metadata: {},
    products,
    features: {},
  }
}

function buildProduct(
  partial: Partial<Customer["products"][number]> = {},
): Customer["products"][number] {
  return {
    id: "starter",
    name: "Starter",
    group: null,
    status: "active" as Customer["products"][number]["status"],
    started_at: Date.now(),
    canceled_at: null,
    version: 1,
    is_add_on: false,
    is_default: false,
    items: [],
    ...partial,
  }
}

describe("SettingsPage BYO entitlement gating", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionResult = { _tag: "success", value: { roles: ["org:admin"] } }
    mocks.customer = buildCustomer([
      buildProduct(),
    ])
    mocks.customer!.features = {
      bringyourowncloud: { id: "bringyourowncloud", name: "Bring Your Own Cloud", type: "static" as const },
    }
    mocks.isCustomerLoading = false
    mocks.orgSectionProps = []
    mocks.tabsValue = ""
    vi.spyOn(SettingsRoute.Route, "useSearch").mockReturnValue({ tab: "members" })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("shows Data Platform when bringyourowncloud is attached", () => {
    vi.spyOn(SettingsRoute.Route, "useSearch").mockReturnValue({ tab: "data-platform" })
    render(<SettingsRoute.SettingsPage />)

    expect(screen.getByRole("button", { name: "Data Platform" })).toBeTruthy()
    expect(screen.getByText("org-tinybird-settings-section")).toBeTruthy()
    expect(mocks.orgSectionProps).toEqual([{ isAdmin: true, hasEntitlement: true }])
  })

  it("hides Data Platform and falls back to the first allowed tab when bringyourowncloud is missing", () => {
    mocks.customer = buildCustomer([buildProduct()])

    render(<SettingsRoute.SettingsPage />)

    expect(screen.queryByRole("button", { name: "Data Platform" })).toBeNull()
    expect(screen.getByText("members-section")).toBeTruthy()
    expect(screen.queryByText("org-tinybird-settings-section")).toBeNull()
    expect(mocks.orgSectionProps).toEqual([])
  })
})
