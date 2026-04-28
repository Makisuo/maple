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
import { useIsMobile } from "@maple/ui/hooks/use-mobile"
import { LayoutLeftIcon } from "@/components/icons"
import { Link, defaultParseSearch } from "@tanstack/react-router"

export interface BreadcrumbItem {
	label: string
	href?: string
}

interface DashboardLayoutProps {
	children: React.ReactNode
	breadcrumbs: BreadcrumbItem[]
	title?: string
	titleContent?: React.ReactNode
	description?: string
	headerActions?: React.ReactNode
	/** Render a filter sidebar flush to the left of the content area, spanning full height. */
	filterSidebar?: React.ReactNode
	/** Content pinned above the scrollable children (e.g. volume charts). */
	stickyContent?: React.ReactNode
	/** Render actions in the breadcrumb header bar, right-aligned. */
	breadcrumbActions?: React.ReactNode
	/** Render a panel on the right side of the content area (e.g. AI chat). */
	rightSidebar?: React.ReactNode
}

function parseSearchFromHref(href: string): { pathname: string; search?: Record<string, unknown> } {
	const [pathname, queryString] = href.split("?")
	if (!queryString) {
		return { pathname }
	}
	return { pathname, search: defaultParseSearch(queryString) as Record<string, unknown> }
}

export function DashboardLayout({
	children,
	breadcrumbs,
	title,
	titleContent,
	description,
	headerActions,
	filterSidebar,
	stickyContent,
	breadcrumbActions,
	rightSidebar,
}: DashboardLayoutProps) {
	const isMobile = useIsMobile()
	const hasHeader = title || titleContent || description || headerActions

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
				<PageLayout.Root>
					<header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
						<SidebarTrigger className="-ml-1" />
						<Separator orientation="vertical" className="mr-2 h-4" />
						<Breadcrumb>
							<BreadcrumbList>
								{breadcrumbs.map((item, index) => (
									<React.Fragment key={item.label}>
										{index > 0 && <BreadcrumbSeparator />}
										<BreadcrumbItem>
											{item.href ? (
												(() => {
													const { pathname, search } = parseSearchFromHref(
														item.href,
													)
													if (!search) {
														return (
															<BreadcrumbLink render={<Link to={pathname} />}>
																{item.label}
															</BreadcrumbLink>
														)
													}
													return (
														<BreadcrumbLink
															render={
																<Link
																	to={pathname}
																	search={search as never}
																/>
															}
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
						{(breadcrumbActions || (filterSidebar && isMobile)) && (
							<div className="ml-auto flex shrink-0 items-center gap-2">
								{filterSidebar && isMobile && (
									<PageLayout.FilterSidebarTrigger>
										<Button variant="outline" size="icon-sm" aria-label="Open filters">
											<LayoutLeftIcon size={16} />
										</Button>
									</PageLayout.FilterSidebarTrigger>
								)}
								{breadcrumbActions}
							</div>
						)}
					</header>
					<PageLayout.Body>
						{filterSidebar && (
							<PageLayout.FilterSidebar>{filterSidebar}</PageLayout.FilterSidebar>
						)}
						<PageLayout.Content>
							{(hasHeader || stickyContent) && (
								<PageLayout.StickyArea>
									{hasHeader && (
										<PageLayout.Header
											title={title}
											titleContent={titleContent}
											description={description}
										>
											{headerActions && (
												<PageLayout.HeaderActions>
													{headerActions}
												</PageLayout.HeaderActions>
											)}
										</PageLayout.Header>
									)}
									{stickyContent}
								</PageLayout.StickyArea>
							)}
							<PageLayout.ScrollArea>{children}</PageLayout.ScrollArea>
						</PageLayout.Content>
						{rightSidebar && <PageLayout.RightSidebar>{rightSidebar}</PageLayout.RightSidebar>}
					</PageLayout.Body>
				</PageLayout.Root>
			</SidebarInset>
		</SidebarProvider>
	)
}
