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

const featureLinks = [
  { href: "/features/distributed-tracing", label: () => m.nav_distributed_tracing() },
  { href: "/features/metrics-dashboards", label: () => m.nav_metrics_dashboards() },
  { href: "/features/log-management", label: () => m.nav_log_management() },
  { href: "/features/service-catalog", label: () => m.nav_service_catalog() },
  { href: "/features/error-tracking", label: () => m.nav_error_tracking() },
  { href: "/features/ai-mcp-integration", label: () => m.nav_ai_mcp() },
]

const useCaseLinks = [
  { href: "/use-cases/ecommerce-observability", label: () => m.nav_ecommerce() },
  { href: "/use-cases/microservices-debugging", label: () => m.nav_microservices() },
  { href: "/use-cases/api-performance", label: () => m.nav_api_performance() },
]

const compareLinks = [
  { href: "/compare/datadog", label: () => m.nav_vs_datadog() },
  { href: "/compare/grafana", label: () => m.nav_vs_grafana() },
  { href: "/compare/new-relic", label: () => m.nav_vs_new_relic() },
]

const integrationLinks = [
  { href: "/integrations/nextjs", label: () => m.nav_nextjs() },
  { href: "/integrations/python", label: () => m.nav_python() },
  { href: "/integrations/nodejs", label: () => m.nav_nodejs() },
]

function NavBarInner() {
  const { isSignedIn, isLoaded } = useAuth()

  return (
    <div className="flex items-center justify-between h-full">
      {/* Left group: Logo + Navigation */}
      <div className="flex items-center gap-1">
        <a href="/" className="flex items-center gap-3 mr-2">
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
              <a href="/pricing" className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all">
                {m.nav_pricing()}
              </a>
            </NavigationMenuItem>

            <NavigationMenuItem>
              <a href="/roadmap" className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all">
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
          {isLoaded && isSignedIn ? m.nav_dashboard() : m.nav_get_started()}
        </a>
      </div>
    </div>
  )
}

export function NavBar() {
  return (
    <ClerkProvider>
      <NavBarInner />
    </ClerkProvider>
  )
}
