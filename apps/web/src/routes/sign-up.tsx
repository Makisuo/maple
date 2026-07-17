import { SignUp } from "@clerk/clerk-react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { validateInternalRedirect } from "@maple/ui/lib/sanitizers"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { AuthLayout } from "@/components/layout/auth-layout"
import { clerkAppearance } from "@/lib/clerk-appearance"

const SignUpSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/sign-up")({
	component: SignUpPage,
	validateSearch: Schema.toStandardSchemaV1(SignUpSearch),
})

function SignUpPage() {
	const { redirect_url } = Route.useSearch()
	// Without an explicit redirect Clerk sends fresh sign-ups to "/"; new users
	// belong in onboarding (matches getSignUpRedirectTarget in __root.tsx).
	const target = validateInternalRedirect(redirect_url ?? null)

	if (!isClerkAuthEnabled) {
		return <Navigate to="/" replace />
	}

	return (
		<AuthLayout>
			<SignUp appearance={clerkAppearance} forceRedirectUrl={target ?? "/quick-start"} />
		</AuthLayout>
	)
}
