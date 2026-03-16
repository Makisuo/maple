import { useAuth } from "@clerk/clerk-react"
import {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink,
} from "@maple/ui/components/ui/navigation-menu"
import * as m from "../paraglide/messages"
import { ClerkProvider } from "./ClerkProvider"

const PUBLISHABLE_KEY = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY

function AuthAwareCTA() {
  const { isSignedIn, isLoaded } = useAuth()
  return isLoaded && isSignedIn ? m.nav_dashboard() : m.nav_get_started()
}

function CTAButton() {
  // Only use Clerk auth hook when the provider is actually available
  if (!PUBLISHABLE_KEY) {
    return m.nav_get_started()
  }
  return <AuthAwareCTA />
}

function NavBarInner({ locale = "en" }: { locale?: string }) {
  const l = (path: string) => locale === "en" ? path : `/${locale}${path}`

  const featureLinks = [
    { href: l("/features/distributed-tracing"), label: () => m.nav_distributed_tracing() },
    { href: l("/features/metrics-dashboards"), label: () => m.nav_metrics_dashboards() },
    { href: l("/features/log-management"), label: () => m.nav_log_management() },
    { href: l("/features/service-catalog"), label: () => m.nav_service_catalog() },
    { href: l("/features/error-tracking"), label: () => m.nav_error_tracking() },
    { href: l("/features/ai-mcp-integration"), label: () => m.nav_ai_mcp() },
  ]

  const useCaseLinks = [
    { href: l("/use-cases/ecommerce-observability"), label: () => m.nav_ecommerce() },
    { href: l("/use-cases/microservices-debugging"), label: () => m.nav_microservices() },
    { href: l("/use-cases/api-performance"), label: () => m.nav_api_performance() },
  ]

  const compareLinks = [
    { href: l("/compare/datadog"), label: () => m.nav_vs_datadog() },
    { href: l("/compare/grafana"), label: () => m.nav_vs_grafana() },
    { href: l("/compare/new-relic"), label: () => m.nav_vs_new_relic() },
  ]

  const integrationLinks = [
    { href: l("/integrations/nextjs"), label: () => m.nav_nextjs() },
    { href: l("/integrations/python"), label: () => m.nav_python() },
    { href: l("/integrations/nodejs"), label: () => m.nav_nodejs() },
  ]

  return (
    <div className="flex items-center justify-between h-full w-full">
      {/* Left group: Logo + Navigation */}
      <div className="flex items-center gap-1">
        <a href={l("/")} className="flex items-center gap-3 mr-2">
          <div className="w-7 h-7 bg-accent flex items-center justify-center">
            <span className="text-accent-foreground text-sm font-bold">M</span>
          </div>
          <span className="text-fg font-medium text-sm">Maple</span>
        </a>

        <NavigationMenu className="hidden sm:flex">
          <NavigationMenuList>
            <NavigationMenuItem>
              <NavigationMenuTrigger className="bg-transparent hover:bg-muted/20 text-fg-muted hover:text-fg">
                {m.nav_features()}
              </NavigationMenuTrigger>
              <NavigationMenuContent>
                <div className="grid grid-cols-2 gap-1 p-2">
                  {featureLinks.map((link) => (
                    <NavigationMenuLink
                      key={link.href}
                      href={link.href}
                      className="whitespace-nowrap"
                    >
                      {link.label()}
                    </NavigationMenuLink>
                  ))}
                </div>
              </NavigationMenuContent>
            </NavigationMenuItem>

            <NavigationMenuItem>
              <NavigationMenuTrigger className="bg-transparent hover:bg-muted/20 text-fg-muted hover:text-fg">
                {m.nav_use_cases()}
              </NavigationMenuTrigger>
              <NavigationMenuContent>
                <div className="p-2 min-w-[220px]">
                  {useCaseLinks.map((link) => (
                    <NavigationMenuLink
                      key={link.href}
                      href={link.href}
                    >
                      {link.label()}
                    </NavigationMenuLink>
                  ))}
                </div>
              </NavigationMenuContent>
            </NavigationMenuItem>

<NavigationMenuItem>
              <NavigationMenuTrigger className="bg-transparent hover:bg-muted/20 text-fg-muted hover:text-fg">
                {m.nav_integrations()}
              </NavigationMenuTrigger>
              <NavigationMenuContent>
                <div className="p-2 min-w-[220px]">
                  {integrationLinks.map((link) => (
                    <NavigationMenuLink
                      key={link.href}
                      href={link.href}
                    >
                      {link.label()}
                    </NavigationMenuLink>
                  ))}
                </div>
              </NavigationMenuContent>
            </NavigationMenuItem>

            <NavigationMenuItem>
              <a href={l("/pricing")} className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all">
                {m.nav_pricing()}
              </a>
            </NavigationMenuItem>

            <NavigationMenuItem>
              <a href={l("/roadmap")} className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all">
                {m.nav_roadmap()}
              </a>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </div>

      {/* Right group: GitHub + CTA */}
      <div className="flex items-center gap-6">
        <a
          href="https://github.com/Makisuo/maple"
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg-muted hover:text-fg transition-colors hidden sm:block"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
        </a>

        <a
          href="https://app.maple.dev"
          className="bg-accent text-accent-foreground px-4 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity"
        >
          <CTAButton />
        </a>
      </div>
    </div>
  )
}

export function NavBar({ locale = "en" }: { locale?: string }) {
  return (
    <ClerkProvider>
      <NavBarInner locale={locale} />
    </ClerkProvider>
  )
}
