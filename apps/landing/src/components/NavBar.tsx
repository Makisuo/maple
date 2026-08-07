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
import { buttonVariants } from "@maple/ui/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { cn } from "@maple/ui/lib/utils"
import * as m from "../paraglide/messages"
import { broadcastSignedIn } from "./auth-signal"
import { ClerkProvider } from "./ClerkProvider"
import { formatStars } from "../lib/github-stars"
import { features } from "../lib/features"
import { featurePath, useCasePath } from "../lib/page-registry"
import { useCases } from "../lib/use-cases"
import { identifyLanding } from "../lib/telemetry"
import { GithubStarButton, Octocat } from "./GithubStarButton"

const PUBLISHABLE_KEY = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY

type MenuLink = { href: string; label: () => string; desc: () => string }

function AuthAwareCTA() {
	const { isSignedIn, isLoaded, userId } = useAuth()
	const signedIn = isLoaded && isSignedIn === true
	useEffect(() => {
		broadcastSignedIn(signedIn)
		// This island is the only place Clerk is mounted, so it is also the only
		// place that can name the visitor. Anonymous visitors still link to their
		// later app sessions through the cross-subdomain visitor cookie.
		identifyLanding(signedIn ? userId : null)
	}, [signedIn, userId])
	return signedIn ? m.nav_dashboard() : m.nav_get_started()
}

function CTAButton() {
	// Only use Clerk auth hook when the provider is actually available
	if (!PUBLISHABLE_KEY) {
		return m.nav_get_started()
	}
	return <AuthAwareCTA />
}

function Eyebrow({ children }: { children: React.ReactNode }) {
	return <span className="text-[11px] uppercase tracking-wider font-medium text-primary">{children}</span>
}

function MegaLink({ link }: { link: MenuLink }) {
	return (
		<NavigationMenuLink
			href={link.href}
			className="group/link flex flex-col items-start gap-0.5 rounded-lg p-2 hover:bg-muted/20"
		>
			<span className="text-xs font-medium text-fg transition-colors group-hover/link:text-primary">
				{link.label()}
			</span>
			<span className="text-[11px] leading-snug text-fg-muted">{link.desc()}</span>
		</NavigationMenuLink>
	)
}

/**
 * True while the header CTA should be collapsed: only on mobile (<sm), and only
 * while the page's hero CTA (`[data-hero-cta]`) is in the viewport. On sm+ the
 * header CTA always shows, and pages without a hero CTA always show it too.
 */
function useHeaderCtaCollapsed() {
	const [collapsed, setCollapsed] = useState(false)
	useEffect(() => {
		const target = document.querySelector("[data-hero-cta]")
		if (!target) return
		const desktop = window.matchMedia("(min-width: 640px)")
		let heroVisible = false
		const update = () => setCollapsed(heroVisible && !desktop.matches)
		const observer = new IntersectionObserver(([entry]) => {
			heroVisible = entry.isIntersecting
			update()
		})
		observer.observe(target)
		desktop.addEventListener("change", update)
		return () => {
			observer.disconnect()
			desktop.removeEventListener("change", update)
		}
	}, [])
	return collapsed
}

function NavBarInner({ locale = "en", stars }: { locale?: string; stars?: number | null }) {
	const [menuOpen, setMenuOpen] = useState(false)
	const ctaCollapsed = useHeaderCtaCollapsed()
	const l = (path: string) => (locale === "en" ? path : `/${locale}${path}`)

	// Derived from the registries rather than hand-listed, so adding a feature
	// can't leave the nav pointing at seven of eight. `navLabel`/`navDesc` are
	// stored uncalled for the same reason MenuLink holds thunks — Paraglide
	// resolves the locale per call, at render.
	const featureLinks: MenuLink[] = features.map((feature) => ({
		href: featurePath(locale, feature.slug),
		label: feature.navLabel,
		desc: feature.navDesc,
	}))

	const useCaseLinks: MenuLink[] = useCases.map((useCase) => ({
		href: useCasePath(locale, useCase.slug),
		label: useCase.navLabel,
		desc: useCase.navDesc,
	}))

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
		<div className="relative flex items-center justify-between h-full w-full">
			{/* Logo. The nav list is absolutely centred rather than laid out
			    between the two groups, so the centring survives the asymmetric
			    right-hand group (star pill + Log in + CTA). */}
			<div className="flex items-center">
				<a href={l("/")} className="flex items-center gap-2.5">
					<MapleMark size={26} className="text-primary shrink-0" />
					<span className="text-fg font-medium text-sm">Maple</span>
				</a>
			</div>

			<div className="absolute left-1/2 hidden -translate-x-1/2 lg:block">
				<NavigationMenu className="flex">
					<NavigationMenuList>
						<NavigationMenuItem>
							<NavigationMenuTrigger className="h-9 bg-transparent hover:bg-muted/20 text-[13px] text-fg-muted hover:text-fg data-popup-open:text-fg">
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
										<span className="inline-flex items-center gap-1 text-xs text-primary transition-transform group-hover/cta:translate-x-0.5">
											{m.nav_product_footer_cta()}
										</span>
									</NavigationMenuLink>
								</div>
							</NavigationMenuContent>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href={l("/pricing")}
								className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-[13px] font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								{m.nav_pricing()}
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href={l("/local")}
								className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-[13px] font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								{m.nav_local()}
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href="/docs"
								className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-[13px] font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								{m.nav_docs()}
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href="/blog"
								className="inline-flex h-9 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-[13px] font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								{m.nav_blog()}
							</a>
						</NavigationMenuItem>
					</NavigationMenuList>
				</NavigationMenu>
			</div>

			{/* Right group: GitHub + Log in + CTA + Mobile menu */}
			<div className="flex items-center gap-3 sm:gap-4">
				<GithubStarButton stars={stars} className="hidden sm:inline-flex" />

				<a
					href="https://app.maple.dev"
					data-track="cta_click"
					data-track-location="nav_login"
					className="hidden text-[13px] font-medium text-fg-muted transition-colors hover:text-fg md:inline-flex"
				>
					{m.nav_login()}
				</a>

				<a
					href="https://app.maple.dev"
					data-track="cta_click"
					data-track-location="nav"
					className={cn(
						buttonVariants({ size: "sm" }),
						"overflow-hidden transition-all duration-300",
						ctaCollapsed
							? "pointer-events-none max-w-0 border-0 px-0 opacity-0 -ml-3"
							: "max-w-40 opacity-100 ml-0",
					)}
					aria-hidden={ctaCollapsed}
					tabIndex={ctaCollapsed ? -1 : undefined}
				>
					<CTAButton />
				</a>

				{/* The centred nav list only fits from lg, so the sheet has to
				    cover everything below it — not just below sm. */}
				<button
					className="lg:hidden p-1.5 text-fg-muted hover:text-fg transition-colors"
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
							<span className="text-[11px] text-primary uppercase tracking-wider font-medium">
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
								{m.nav_local()}
							</a>
							<a
								href="/docs"
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								{m.nav_docs()}
							</a>
							<a
								href="/blog"
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								{m.nav_blog()}
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
								data-track="cta_click"
								data-track-location="nav_mobile"
								className={buttonVariants({ size: "sm" })}
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
