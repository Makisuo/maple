import * as React from "react"

import { cn } from "../../lib/utils"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./sheet"
import { useIsMobile } from "../../hooks/use-mobile"

/* -------------------------------------------------------------------------------------------------
 * Context
 * -------------------------------------------------------------------------------------------------*/

interface PageLayoutContextValue {
	isScrolled: boolean
	setIsScrolled: (scrolled: boolean) => void
	filterSheetOpen: boolean
	setFilterSheetOpen: (open: boolean) => void
	isMobile: boolean
}

const PageLayoutContext = React.createContext<PageLayoutContextValue | null>(null)

function usePageLayout() {
	const ctx = React.use(PageLayoutContext)
	if (!ctx) throw new Error("PageLayout.* components must be used within <PageLayout>")
	return ctx
}

/* -------------------------------------------------------------------------------------------------
 * Root
 * -------------------------------------------------------------------------------------------------*/

function Root({ children, className }: { children: React.ReactNode; className?: string }) {
	const [isScrolled, setIsScrolled] = React.useState(false)
	const [filterSheetOpen, setFilterSheetOpen] = React.useState(false)
	const isMobile = useIsMobile()

	const ctx = React.useMemo(
		() => ({ isScrolled, setIsScrolled, filterSheetOpen, setFilterSheetOpen, isMobile }),
		[isScrolled, filterSheetOpen, isMobile],
	)

	return (
		<PageLayoutContext value={ctx}>
			<div data-slot="page-layout" className={cn("flex min-h-0 flex-1 flex-col", className)}>
				{children}
			</div>
		</PageLayoutContext>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Header
 * -------------------------------------------------------------------------------------------------*/

interface HeaderProps {
	children?: React.ReactNode
	title?: string
	titleContent?: React.ReactNode
	description?: string
	className?: string
}

function Header({ children, title, titleContent, description, className }: HeaderProps) {
	const hasContent = title || titleContent || description || children
	if (!hasContent) return null

	return (
		<div
			data-slot="page-header"
			className={cn(
				"flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4",
				className,
			)}
		>
			<div className="min-w-0 flex-1">
				{titleContent ??
					(title && (
						<h1
							className="font-display text-3xl font-semibold tracking-tight truncate leading-[1.1]"
							title={title}
						>
							{title}
						</h1>
					))}
				{description && <p className="text-muted-foreground">{description}</p>}
			</div>
			{children}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * HeaderActions
 * -------------------------------------------------------------------------------------------------*/

function HeaderActions({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div data-slot="page-header-actions" className={cn("shrink-0 overflow-x-auto", className)}>
			{children}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * StickyArea — header + sticky content wrapper with scroll shadow
 * -------------------------------------------------------------------------------------------------*/

function StickyArea({ children, className }: { children: React.ReactNode; className?: string }) {
	const { isScrolled } = usePageLayout()

	return (
		<div
			data-slot="page-sticky-area"
			className={cn(
				"shrink-0 space-y-4 p-4 transition-shadow",
				isScrolled && "shadow-[0_2px_8px_rgba(0,0,0,0.08)]",
				className,
			)}
		>
			{children}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Body — horizontal layout with optional filter sidebar, content, and right sidebar
 * -------------------------------------------------------------------------------------------------*/

function Body({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div data-slot="page-body" className={cn("flex min-h-0 flex-1 overflow-hidden", className)}>
			{children}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * FilterSidebar — responsive: inline on desktop, sheet on mobile
 * -------------------------------------------------------------------------------------------------*/

function FilterSidebar({
	children,
	className,
	width = "w-64",
}: {
	children: React.ReactNode
	className?: string
	width?: string
}) {
	const { isMobile, filterSheetOpen, setFilterSheetOpen } = usePageLayout()

	if (isMobile) {
		return (
			<Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
				<SheetContent side="left" className="w-72 p-4 overflow-y-auto">
					<SheetHeader className="sr-only">
						<SheetTitle>Filters</SheetTitle>
						<SheetDescription>Filter options for this page.</SheetDescription>
					</SheetHeader>
					{children}
				</SheetContent>
			</Sheet>
		)
	}

	return (
		<aside
			data-slot="page-filter-sidebar"
			className={cn("sticky top-0 h-full shrink-0 overflow-y-auto border-r p-4", width, className)}
		>
			{children}
		</aside>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Content — flex column container for sticky area + scroll area
 * -------------------------------------------------------------------------------------------------*/

function Content({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<main
			id="main-content"
			data-slot="page-content"
			className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}
		>
			{children}
		</main>
	)
}

/* -------------------------------------------------------------------------------------------------
 * ScrollArea — scrollable area within Content, tracks scroll for shadow effect
 * -------------------------------------------------------------------------------------------------*/

function ScrollArea({ children, className }: { children: React.ReactNode; className?: string }) {
	const { setIsScrolled } = usePageLayout()

	return (
		<div
			data-slot="page-scroll-area"
			className={cn("flex min-h-0 flex-1 flex-col overflow-auto p-4", className)}
			onScroll={(e) => setIsScrolled(e.currentTarget.scrollTop > 0)}
		>
			{children}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * RightSidebar
 * -------------------------------------------------------------------------------------------------*/

function RightSidebar({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<aside data-slot="page-right-sidebar" className={cn("hidden lg:block", className)}>
			{children}
		</aside>
	)
}

/* -------------------------------------------------------------------------------------------------
 * FilterSidebarTrigger — button to open filter sheet on mobile
 * -------------------------------------------------------------------------------------------------*/

function FilterSidebarTrigger({ children }: { children: React.ReactNode }) {
	const { isMobile, setFilterSheetOpen } = usePageLayout()

	if (!isMobile) return null

	return <span onClick={() => setFilterSheetOpen(true)}>{children}</span>
}

/* -------------------------------------------------------------------------------------------------
 * Exports
 * -------------------------------------------------------------------------------------------------*/

export const PageLayout = {
	Root,
	Header,
	HeaderActions,
	StickyArea,
	Body,
	FilterSidebar,
	FilterSidebarTrigger,
	Content,
	ScrollArea,
	RightSidebar,
}

export { usePageLayout }
