import { OrganizationSwitcher, useAuth } from "@clerk/clerk-react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { AuthLayout } from "@/components/layout/auth-layout"

const OrgRequiredSearch = Schema.Struct({
  redirect_url: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/org-required")({
  component: OrgRequiredPage,
  validateSearch: Schema.standardSchemaV1(OrgRequiredSearch),
})

function OrgRequiredPage() {
  if (!isClerkAuthEnabled) {
    return <Navigate to="/" replace />
  }

  return <OrgRequiredPageClerk />
}

function OrgRequiredPageClerk() {
  const { isLoaded, isSignedIn, orgId } = useAuth()
  const { redirect_url } = Route.useSearch()

  if (!isLoaded) {
    return null
  }

  if (!isSignedIn) {
    return <Navigate to="/sign-in" search={{ redirect_url }} replace />
  }

  if (orgId) {
    return <Navigate to={redirect_url || "/"} replace />
  }

  return (
    <AuthLayout maxWidth="max-w-lg">
      <h1 className="text-xl font-semibold">Organization required</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Select or create an organization before entering the app.
      </p>
      <div className="mt-4">
        <OrganizationSwitcher hidePersonal />
      </div>
    </AuthLayout>
  )
}
