import * as React from "react"

import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@maple/ui/components/ui/sidebar"
import { Separator } from "@maple/ui/components/ui/separator"
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@maple/ui/components/ui/breadcrumb"
import { PageLayout } from "@maple/ui/components/ui/page-layout"
import { Button } from "@maple/ui/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { ChatBubbleSparkleIcon, LayoutLeftIcon } from "@/components/icons"
import { openGlobalChat } from "@/components/chat/global-chat-sheet"
import { ConnectButton } from "@/components/header/connect-button"
import { QuotaBanner } from "@/components/billing/quota-banner"
import { PaymentFailedBanner } from "@/components/billing/payment-failed-banner"
import { Link, defaultParseSearch } from "@tanstack/react-router"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

/* -------------------------------------------------------------------------------------------------
 * DashboardLayout — the app's page shell, as a compound component.
 *
 * Presence is composition: a page has a filter sidebar because it renders
 * `<DashboardLayout.Filters>`, not because it passed a `filterSidebar` prop that
 * the shell then had to test for. That removed six ReactNode slot props and the
 * `hasHeader = title || titleContent || description || headerActions` derivation
 * they forced.
 *
 * The nesting is real, not decorative: `Filters | Content | RightPanel` are flex
 * siblings inside `Body`, and `Sticky | Scroll` stack inside `Content`. Slot
 * registration through context or portals could hide that, but both need an
 * effect or a DOM node that doesn't exist during SSR — so the tree you write is
 * the tree that renders.
 *
 * `breadcrumbs` stays a prop because it is data (a `{label, href}[]`), not
 * composition.
 * -----------------------------------------------------------------------------------------------*/

interface BreadcrumbEntry {
	label: string
	href?: string
}

function parseSearchFromHref(href: string): { pathname: string; search?: Record<string, unknown> } {
	const [pathname, queryString] = href.split("?")
	if (!queryString) {
		return { pathname }
	}
	return { pathname, search: defaultParseSearch(queryString) as Record<string, unknown> }
}

/** Sidebar + inset + skip link + `PageLayout.Root`. Everything else composes inside. */
function Root({ children }: { children: React.ReactNode }) {
	return (
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<a
					href="#main-content"
					className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground"
				>
					Skip to main content
				</a>
				<PageLayout.Root>{children}</PageLayout.Root>
			</SidebarInset>
		</SidebarProvider>
	)
}

/**
 * The top bar: sidebar trigger, breadcrumb trail, and the persistent right-hand
 * cluster (AI chat, connection status, the mobile filter trigger). `children` are
 * extra page-specific actions, appended to that cluster.
 */
function Breadcrumbs({ items, children }: { items: BreadcrumbEntry[]; children?: React.ReactNode }) {
	return (
		<header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
			<SidebarTrigger className="-ml-1" />
			<Separator orientation="vertical" className="mr-2 h-4" />
			<Breadcrumb>
				<BreadcrumbList>
					{items.map((item, index) => (
						<React.Fragment key={item.label}>
							{index > 0 && <BreadcrumbSeparator />}
							<BreadcrumbItem>
								{item.href ? (
									(() => {
										const { pathname, search } = parseSearchFromHref(item.href)
										if (!search) {
											return (
												<BreadcrumbLink render={<Link to={pathname} />}>
													{item.label}
												</BreadcrumbLink>
											)
										}
										return (
											<BreadcrumbLink
												render={<Link to={pathname} search={search as never} />}
											>
												{item.label}
											</BreadcrumbLink>
										)
									})()
								) : (
									<BreadcrumbPage>{item.label}</BreadcrumbPage>
								)}
							</BreadcrumbItem>
						</React.Fragment>
					))}
				</BreadcrumbList>
			</Breadcrumb>
			<div className="ml-auto flex shrink-0 items-center gap-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="outline"
								size="icon-sm"
								aria-label="Open AI chat"
								onClick={openGlobalChat}
							/>
						}
					>
						<ChatBubbleSparkleIcon size={16} />
					</TooltipTrigger>
					<TooltipContent className="flex items-center gap-1.5">
						Ask Maple AI <Kbd>C</Kbd>
					</TooltipContent>
				</Tooltip>
				<ConnectButton />
				{/* Renders only when the sidebar has collapsed to a sheet, and only when a
				    `Filters` region exists to open — `PageLayout` owns both conditions. */}
				<PageLayout.FilterSidebarTrigger>
					<Button variant="outline" size="icon-sm" aria-label="Open filters">
						<LayoutLeftIcon size={16} />
					</Button>
				</PageLayout.FilterSidebarTrigger>
				{children}
			</div>
		</header>
	)
}

/** Billing banners + the horizontal `Filters | Content | RightPanel` row. */
function Body({ children }: { children: React.ReactNode }) {
	return (
		<>
			{isClerkAuthEnabled && <PaymentFailedBanner />}
			{isClerkAuthEnabled && <QuotaBanner />}
			<PageLayout.Body>{children}</PageLayout.Body>
		</>
	)
}

/** Filter rail, flush left of the content and full height. A sheet below `lg`. */
function Filters({ children }: { children: React.ReactNode }) {
	return <PageLayout.FilterSidebar>{children}</PageLayout.FilterSidebar>
}

/** The main column: `Sticky` (optional) above `Scroll`. */
function Content({ children }: { children: React.ReactNode }) {
	return <PageLayout.Content>{children}</PageLayout.Content>
}

/** Pinned above the scroll area — the page header, and anything else that shouldn't scroll away. */
function Sticky({ children }: { children: React.ReactNode }) {
	return <PageLayout.StickyArea>{children}</PageLayout.StickyArea>
}

/**
 * Page title/description, with `children` as the right-aligned actions.
 *
 * `titleContent` is the one remaining slot prop, and deliberately so: a handful
 * of pages need a heading that isn't a plain string (a service dot beside the
 * name, a status badge). Put a `DashboardLayout.Title` inside it rather than a
 * hand-rolled `<h1>` — that's how six different title typographies accumulated.
 */
function Header({
	title,
	titleContent,
	description,
	children,
}: {
	title?: string
	titleContent?: React.ReactNode
	description?: string
	children?: React.ReactNode
}) {
	return (
		<PageLayout.Header title={title} titleContent={titleContent} description={description}>
			{children && <PageLayout.HeaderActions>{children}</PageLayout.HeaderActions>}
		</PageLayout.Header>
	)
}

/** The scrolling page body. */
function Scroll({ children }: { children: React.ReactNode }) {
	return <PageLayout.ScrollArea>{children}</PageLayout.ScrollArea>
}

/** Right-hand panel (e.g. the AI chat dock). Hidden below `lg`. */
function RightPanel({ children }: { children: React.ReactNode }) {
	return <PageLayout.RightSidebar>{children}</PageLayout.RightSidebar>
}

export const DashboardLayout = {
	Root,
	Breadcrumbs,
	Body,
	Filters,
	Content,
	Sticky,
	Header,
	Scroll,
	RightPanel,
	/** Escape hatch for a page whose title is more than a string (a badge, a service dot). */
	Title: PageLayout.Title,
	Description: PageLayout.Description,
}
