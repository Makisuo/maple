import { SignUp } from "@clerk/clerk-react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const SignUpSearch = Schema.Struct({
  redirect_url: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/sign-up")({
  component: SignUpPage,
  validateSearch: Schema.standardSchemaV1(SignUpSearch),
})

function SignUpPage() {
  if (!isClerkAuthEnabled) {
    return <Navigate to="/" replace />
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <SignUp />
    </main>
  )
}
