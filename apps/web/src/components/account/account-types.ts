import type { useUser } from "@clerk/clerk-react"

/**
 * Clerk's resource types live in `@clerk/types`, which is not a dependency of this app — only
 * `@clerk/clerk-react` is, and it re-exports just a handful of them. Deriving what we need from
 * the `user` resource keeps these in lockstep with whatever version is installed instead of
 * pinning a second Clerk package that could skew from it.
 */
export type ClerkUser = NonNullable<ReturnType<typeof useUser>["user"]>

export type EmailAddress = ClerkUser["emailAddresses"][number]
export type Passkey = ClerkUser["passkeys"][number]
export type ExternalAccount = ClerkUser["externalAccounts"][number]
export type SessionWithActivities = Awaited<ReturnType<ClerkUser["getSessions"]>>[number]
export type OAuthStrategy = Parameters<ClerkUser["createExternalAccount"]>[0]["strategy"]
export type UpdatePasswordParams = Parameters<ClerkUser["updatePassword"]>[0]
