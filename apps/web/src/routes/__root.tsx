import { useAuth } from "@clerk/clerk-react"
import { useCustomer } from "autumn-js/react"
import { Navigate, Outlet, createRootRouteWithContext, redirect, useRouterState } from "@tanstack/react-router"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
import { Toaster } from "@maple/ui/components/ui/sonner"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import type { RouterAuthContext } from "@/router"

const PUBLIC_PATHS = new Set(["/sign-in", "/sign-up", "/org-required"])

export const Route = createRootRouteWithContext<{ auth: RouterAuthContext }>()({
  beforeLoad: ({ context, location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return

    const redirectUrl = location.pathname + (location.searchStr ?? "")

    if (!context.auth?.isAuthenticated) {
      throw redirect({
        to: "/sign-in",
        search: { redirect_url: redirectUrl } as Record<string, string>,
      })
    }

    if (!context.auth.orgId) {
      throw redirect({
        to: "/org-required",
        search: { redirect_url: redirectUrl } as Record<string, string>,
      })
    }
  },
  component: RootComponent,
})

function AppFrame() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  )
}

function getRedirectTarget(searchStr: string): string {
  const params = new URLSearchParams(searchStr)
  const target = params.get("redirect_url")
  return target?.startsWith("/") ? target : "/"
}

function ClerkReverseRedirects() {
  const { pathname, searchStr } = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      searchStr: state.location.searchStr,
    }),
  })
  const { isSignedIn, orgId } = useAuth()
  const { customer, isLoading: isCustomerLoading } = useCustomer()

  const redirectUrl = pathname + (searchStr ?? "")
  const selectedPlan = hasSelectedPlan(customer)

  if (isSignedIn && (pathname === "/sign-in" || pathname === "/sign-up")) {
    return <Navigate to={getRedirectTarget(searchStr)} replace />
  }

  if (isSignedIn && orgId && pathname === "/org-required") {
    return <Navigate to={getRedirectTarget(searchStr)} replace />
  }

  if (isSignedIn && orgId) {
    if (isCustomerLoading) {
      return null
    }
    const ALLOWED_WITHOUT_PLAN = ["/select-plan", "/quick-start"]
    if (!selectedPlan && !ALLOWED_WITHOUT_PLAN.includes(pathname)) {
      return <Navigate to="/select-plan" search={{ redirect_url: redirectUrl }} replace />
    }
    if (selectedPlan && pathname === "/select-plan") {
      return <Navigate to={getRedirectTarget(searchStr)} replace />
    }
  }

  return <AppFrame />
}

function RootComponent() {
  if (!isClerkAuthEnabled) {
    return <AppFrame />
  }

  return <ClerkReverseRedirects />
}
