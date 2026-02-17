import { SignIn } from "@clerk/clerk-react"
import { FormEvent, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { setSelfHostedSessionToken } from "@/lib/services/common/self-hosted-auth"

const SignInSearch = Schema.Struct({
  redirect_url: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/sign-in")({
  component: SignInPage,
  validateSearch: Schema.standardSchemaV1(SignInSearch),
})

export const redirectToDashboard = () => {
  const params = new URLSearchParams(window.location.search)
  const redirectUrl = params.get("redirect_url") || "/"
  window.location.assign(redirectUrl)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return "Unable to sign in"
}

async function loginSelfHosted(password: string) {
  const response = await window.fetch(`${apiBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(errorBody?.message ?? "Invalid root password")
  }

  return (await response.json()) as { token: string }
}

export function SelfHostedSignInPage() {
  const [password, setPassword] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting) return

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const result = await loginSelfHosted(password)
      setSelfHostedSessionToken(result.token)
      redirectToDashboard()
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 space-y-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Enter the root password to access Maple.
          </p>
        </div>
        <form className="space-y-3" onSubmit={onSubmit}>
          <Input
            type="password"
            placeholder="Root password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={isSubmitting}
            required
          />
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  )
}

export function SignInPage() {
  if (isClerkAuthEnabled) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <SignIn />
      </main>
    )
  }

  return <SelfHostedSignInPage />
}

export { loginSelfHosted }
