import { SignUp } from "@clerk/clerk-react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { AuthLayout } from "@/components/layout/auth-layout"
import { clerkAppearance } from "@/lib/clerk-appearance"

const SignUpSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/sign-up"))({
	component: SignUpPage,
	validateSearch: Schema.toStandardSchemaV1(SignUpSearch),
})

function SignUpPage() {
	if (!isClerkAuthEnabled) {
		return <Navigate to="/" replace />
	}

	return (
		<AuthLayout>
			<SignUp appearance={clerkAppearance} />
		</AuthLayout>
	)
}
