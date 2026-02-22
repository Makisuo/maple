import { ClerkProvider as ClerkProviderBase } from "@clerk/clerk-react"

const PUBLISHABLE_KEY = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY

export function ClerkProvider({ children }: { children: React.ReactNode }) {
  if (!PUBLISHABLE_KEY) {
    return <>{children}</>
  }

  return <ClerkProviderBase publishableKey={PUBLISHABLE_KEY}>{children}</ClerkProviderBase>
}
