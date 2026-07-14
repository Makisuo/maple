import { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import {
	NavigationMenu,
	NavigationMenuList,
	NavigationMenuItem,
	NavigationMenuTrigger,
	NavigationMenuContent,
	NavigationMenuLink,
} from "@maple/ui/components/ui/navigation-menu"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import * as m from "../paraglide/messages"
import { ClerkProvider } from "./ClerkProvider"
import { formatStars } from "../lib/github-stars"
import { GithubStarButton, Octocat } from "./GithubStarButton"

const PUBLISHABLE_KEY = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY

type MenuLink = { href: string; label: () => string; desc: () => string }

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

function Eyebrow({ children }: { children: React.ReactNode }) {
	return <span className="text-[11px] uppercase tracking-wider font-medium text-accent">{children}</span>
}

function MegaLink({ link }: { link: MenuLink }) {
	return (
		<NavigationMenuLink
			href={link.href}
			className="group/link flex flex-col items-start gap-0.5 rounded-lg p-2 hover:bg-muted/20"
		>
			<span className="text-xs font-medium text-fg transition-colors group-hover/link:text-accent">
				{link.label()}
			</span>
			<span className="text-[11px] leading-snug text-fg-muted">{link.desc()}</span>
		</NavigationMenuLink>
	)
}

/**
 * True while the page's hero CTA (`[data-hero-cta]`) is in the viewport.
 * Pages without a hero CTA report false immediately so the header CTA shows.
 */
function useHeroCtaVisible() {
	// Assume visible during SSR/first paint so the header CTA doesn't flash in at the top of the page
	const [heroCtaVisible, setHeroCtaVisible] = useState(true)
	useEffect(() => {
		const target = document.querySelector("[data-hero-cta]")
		if (!target) {
			setHeroCtaVisible(false)
			return
		}
		const observer = new IntersectionObserver(([entry]) => setHeroCtaVisible(entry.isIntersecting))
		observer.observe(target)
		return () => observer.disconnect()
	}, [])
	return heroCtaVisible
}

function NavBarInner({ locale = "en", stars }: { locale?: string; stars?: number | null }) {
	const [menuOpen, setMenuOpen] = useState(false)
	const heroCtaVisible = useHeroCtaVisible()
	const l = (path: string) => (locale === "en" ? path : `/${locale}${path}`)

	const featureLinks: MenuLink[] = [
		{
			href: l("/features/distributed-tracing"),
			label: () => m.nav_distributed_tracing(),
			desc: () => m.nav_desc_distributed_tracing(),
		},
		{
			href: l("/features/browser-sessions"),
			label: () => m.nav_browser_sessions(),
			desc: () => m.nav_desc_browser_sessions(),
		},
		{
			href: l("/features/metrics-dashboards"),
			label: () => m.nav_metrics_dashboards(),
			desc: () => m.nav_desc_metrics_dashboards(),
		},
		{
			href: l("/features/log-management"),
			label: () => m.nav_log_management(),
			desc: () => m.nav_desc_log_management(),
		},
		{
			href: l("/features/service-catalog"),
			label: () => m.nav_service_catalog(),
			desc: () => m.nav_desc_service_catalog(),
		},
		{
			href: l("/features/error-tracking"),
			label: () => m.nav_error_tracking(),
			desc: () => m.nav_desc_error_tracking(),
		},
		{
			href: l("/features/ai-mcp-integration"),
			label: () => m.nav_ai_mcp(),
			desc: () => m.nav_desc_ai_mcp(),
		},
		{
			href: l("/features/kubernetes-monitoring"),
			label: () => m.nav_kubernetes(),
			desc: () => m.nav_desc_kubernetes(),
		},
	]

	const useCaseLinks: MenuLink[] = [
		{
			href: l("/use-cases/ecommerce-observability"),
			label: () => m.nav_ecommerce(),
			desc: () => m.nav_desc_ecommerce(),
		},
		{
			href: l("/use-cases/microservices-debugging"),
			label: () => m.nav_microservices(),
			desc: () => m.nav_desc_microservices(),
		},
		{
			href: l("/use-cases/api-performance"),
			label: () => m.nav_api_performance(),
			desc: () => m.nav_desc_api_performance(),
		},
	]

	const integrationLinks: MenuLink[] = [
		{ href: l("/integrations/nextjs"), label: () => m.nav_nextjs(), desc: () => m.nav_desc_nextjs() },
		{ href: l("/integrations/python"), label: () => m.nav_python(), desc: () => m.nav_desc_python() },
		{ href: l("/integrations/nodejs"), label: () => m.nav_nodejs(), desc: () => m.nav_desc_nodejs() },
	]

	const compareLinks: MenuLink[] = [
		{ href: l("/compare/datadog"), label: () => m.nav_vs_datadog(), desc: () => m.nav_desc_vs_datadog() },
		{ href: l("/compare/grafana"), label: () => m.nav_vs_grafana(), desc: () => m.nav_desc_vs_grafana() },
		{
			href: l("/compare/new-relic"),
			label: () => m.nav_vs_new_relic(),
			desc: () => m.nav_desc_vs_new_relic(),
		},
		{ href: l("/compare/dash0"), label: () => m.nav_vs_dash0(), desc: () => m.nav_desc_vs_dash0() },
	]

	const mobileGroups: { title: string; links: MenuLink[] }[] = [
		{ title: m.nav_features(), links: featureLinks },
		{ title: m.nav_use_cases(), links: useCaseLinks },
		{ title: m.nav_integrations(), links: integrationLinks },
		{ title: m.nav_compare(), links: compareLinks },
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
							<NavigationMenuTrigger className="h-8 bg-transparent hover:bg-muted/20 text-fg-muted hover:text-fg data-popup-open:text-fg">
								{m.nav_product()}
							</NavigationMenuTrigger>
							<NavigationMenuContent className="p-0">
								<div className="w-[820px] max-w-[calc(100vw-1.5rem)]">
									{/* Top: Features (2x4) + Use Cases + Integrations */}
									<div className="grid grid-cols-12 gap-x-2 p-4">
										<div className="col-span-6">
											<div className="px-2">
												<Eyebrow>{m.nav_features()}</Eyebrow>
											</div>
											<div className="mt-2 grid grid-cols-2 gap-0.5">
												{featureLinks.map((link) => (
													<MegaLink key={link.href} link={link} />
												))}
											</div>
										</div>

										<div className="col-span-3 border-l border-border pl-2">
											<div className="px-2">
												<Eyebrow>{m.nav_use_cases()}</Eyebrow>
											</div>
											<div className="mt-2 flex flex-col gap-0.5">
												{useCaseLinks.map((link) => (
													<MegaLink key={link.href} link={link} />
												))}
											</div>
										</div>

										<div className="col-span-3 border-l border-border pl-2">
											<div className="px-2">
												<Eyebrow>{m.nav_integrations()}</Eyebrow>
											</div>
											<div className="mt-2 flex flex-col gap-0.5">
												{integrationLinks.map((link) => (
													<MegaLink key={link.href} link={link} />
												))}
											</div>
										</div>
									</div>

									{/* Compare row */}
									<div className="border-t border-border px-4 pt-3 pb-4">
										<div className="px-2">
											<Eyebrow>{m.nav_compare()}</Eyebrow>
										</div>
										<div className="mt-2 grid grid-cols-4 gap-0.5">
											{compareLinks.map((link) => (
												<MegaLink key={link.href} link={link} />
											))}
										</div>
									</div>

									{/* Footer CTA strip */}
									<NavigationMenuLink
										href={l("/")}
										className="group/cta flex items-center justify-between rounded-none border-t border-border bg-muted/10 px-6 py-3.5 hover:bg-muted/20"
									>
										<span className="text-xs font-medium text-fg">
											{m.nav_product_footer()}
										</span>
										<span className="inline-flex items-center gap-1 text-xs text-accent transition-transform group-hover/cta:translate-x-0.5">
											{m.nav_product_footer_cta()}
										</span>
									</NavigationMenuLink>
								</div>
							</NavigationMenuContent>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href={l("/pricing")}
								className="inline-flex h-8 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								{m.nav_pricing()}
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href={l("/local")}
								className="inline-flex h-8 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								Local
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href="/docs"
								className="inline-flex h-8 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								Docs
							</a>
						</NavigationMenuItem>
					</NavigationMenuList>
				</NavigationMenu>
			</div>

			{/* Right group: GitHub + CTA + Mobile menu */}
			<div className="flex items-center gap-3 sm:gap-6">
				<GithubStarButton stars={stars} className="hidden sm:inline-flex" />

				<a
					href="https://app.maple.dev"
					className={`inline-flex h-8 items-center justify-center overflow-hidden whitespace-nowrap rounded-lg bg-primary text-xs font-medium text-primary-foreground transition-all duration-300 hover:bg-primary/80 ${
						heroCtaVisible
							? "pointer-events-none max-w-0 px-0 opacity-0 -ml-3 sm:-ml-6"
							: "max-w-40 px-2.5 opacity-100 ml-0"
					}`}
					aria-hidden={heroCtaVisible}
					tabIndex={heroCtaVisible ? -1 : undefined}
				>
					<CTAButton />
				</a>

				<button
					className="sm:hidden p-1.5 text-fg-muted hover:text-fg transition-colors"
					onClick={() => setMenuOpen(true)}
					aria-label="Open menu"
				>
					<svg
						className="w-5 h-5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="square"
					>
						<line x1="4" y1="6" x2="20" y2="6" />
						<line x1="4" y1="12" x2="20" y2="12" />
						<line x1="4" y1="18" x2="20" y2="18" />
					</svg>
				</button>
			</div>

			{/* Mobile menu sheet */}
			<Sheet open={menuOpen} onOpenChange={setMenuOpen}>
				<SheetContent side="right" className="w-full sm:max-w-sm bg-bg overflow-y-auto">
					<SheetHeader>
						<SheetTitle className="text-fg text-sm font-medium">Menu</SheetTitle>
					</SheetHeader>
					<nav className="flex flex-col px-4 pb-6">
						<div className="py-4 border-b border-border">
							<span className="text-[11px] text-accent uppercase tracking-wider font-medium">
								{m.nav_product()}
							</span>
							<div className="mt-3 flex flex-col gap-5">
								{mobileGroups.map((group) => (
									<div key={group.title}>
										<span className="text-[10px] text-fg-muted uppercase tracking-wider">
											{group.title}
										</span>
										<div className="mt-1.5 flex flex-col gap-1">
											{group.links.map((link) => (
												<a
													key={link.href}
													href={link.href}
													onClick={() => setMenuOpen(false)}
													className="text-xs text-fg-muted hover:text-fg transition-colors py-1.5"
												>
													{link.label()}
												</a>
											))}
										</div>
									</div>
								))}
							</div>
						</div>

						<div className="py-4 border-b border-border flex flex-col gap-1">
							<a
								href={l("/pricing")}
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								{m.nav_pricing()}
							</a>
							<a
								href={l("/local")}
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								Local
							</a>
							<a
								href="/docs"
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								Docs
							</a>
						</div>

						<div className="pt-6 flex flex-col gap-4">
							<a
								href="https://github.com/Makisuo/maple"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center justify-between text-xs text-fg-muted hover:text-fg transition-colors"
							>
								<span className="flex items-center gap-2">
									<Octocat className="w-4 h-4" />
									GitHub
								</span>
								{stars != null && <span className="tabular-nums">{formatStars(stars)}</span>}
							</a>
							<a
								href="https://app.maple.dev"
								className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/80"
							>
								<CTAButton />
							</a>
						</div>
					</nav>
				</SheetContent>
			</Sheet>
		</div>
	)
}

export function NavBar({ locale = "en", stars }: { locale?: string; stars?: number | null }) {
	return (
		<ClerkProvider>
			<NavBarInner locale={locale} stars={stars} />
		</ClerkProvider>
	)
}
