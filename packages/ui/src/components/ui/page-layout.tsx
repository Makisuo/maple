import * as React from "react"

import { cn } from "../../lib/utils"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./sheet"
import { useMediaQuery } from "../../hooks/use-media-query"

/* -------------------------------------------------------------------------------------------------
 * Context
 * -------------------------------------------------------------------------------------------------*/

interface PageLayoutContextValue {
	isScrolled: boolean
	setIsScrolled: (scrolled: boolean) => void
	filterSheetOpen: boolean
	setFilterSheetOpen: (open: boolean) => void
	/**
	 * The filter sidebar is a sheet rather than an inline aside. Below `lg` the nav rail plus an
	 * inline filter sidebar leave too little room for page content, so filters move behind a
	 * trigger. Both the sidebar and its trigger read this so they can never disagree — if they
	 * did, filters would render as a sheet with no way to open it.
	 */
	filterSidebarCollapsed: boolean
	/**
	 * Whether a `FilterSidebar` is actually mounted. The trigger lives in the page header and the
	 * sidebar in the body, so the trigger cannot see it as a child — without this it would render a
	 * button that opens a sheet that doesn't exist. Set by `FilterSidebar` on mount.
	 */
	hasFilterSidebar: boolean
	setHasFilterSidebar: (present: boolean) => void
	/** Mirrors the filter sidebar's story on the other edge. See {@link RightSidebar}. */
	rightSheetOpen: boolean
	setRightSheetOpen: (open: boolean) => void
	hasRightSidebar: boolean
	setHasRightSidebar: (present: boolean) => void
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
	const [hasFilterSidebar, setHasFilterSidebar] = React.useState(false)
	const [rightSheetOpen, setRightSheetOpen] = React.useState(false)
	const [hasRightSidebar, setHasRightSidebar] = React.useState(false)
	const filterSidebarCollapsed = useMediaQuery("max-lg")

	const ctx = React.useMemo(
		() => ({
			isScrolled,
			setIsScrolled,
			filterSheetOpen,
			setFilterSheetOpen,
			filterSidebarCollapsed,
			hasFilterSidebar,
			setHasFilterSidebar,
			rightSheetOpen,
			setRightSheetOpen,
			hasRightSidebar,
			setHasRightSidebar,
		}),
		[
			isScrolled,
			filterSheetOpen,
			filterSidebarCollapsed,
			hasFilterSidebar,
			rightSheetOpen,
			hasRightSidebar,
		],
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

/**
 * The page title. Exported so a route rendering custom header content (a title
 * beside a badge, a breadcrumb-style compound name) still gets the one canonical
 * `<h1>` instead of hand-rolling the class string — which is how six different
 * page-title typographies accumulated.
 */
function Title({
	children,
	title,
	className,
}: {
	children: React.ReactNode
	/** `title` attribute for the native tooltip when the heading truncates. */
	title?: string
	className?: string
}) {
	return (
		<h1
			data-slot="page-title"
			className={cn(
				"font-display text-3xl font-semibold tracking-tight truncate leading-[1.1]",
				className,
			)}
			title={title}
		>
			{children}
		</h1>
	)
}

function Description({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<p data-slot="page-description" className={cn("text-muted-foreground", className)}>
			{children}
		</p>
	)
}

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
				"flex flex-col gap-2 @2xl/page:flex-row @2xl/page:items-start @2xl/page:justify-between @2xl/page:gap-4",
				className,
			)}
		>
			<div className="min-w-0 flex-1">
				{/* `title`/`description` stay plain strings — that's data, and it's the
				    30-site happy path. They render *through* `Title`/`Description` so
				    there is exactly one implementation of each. */}
				{titleContent ?? (title && <Title title={title}>{title}</Title>)}
				{description && <Description>{description}</Description>}
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
		<div
			data-slot="page-header-actions"
			// Only pinned to its natural width once the header goes side-by-side. Below that it must
			// be free to shrink, or children that wrap internally never get the chance to.
			className={cn("min-w-0 @2xl/page:shrink-0", className)}
		>
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
	const { filterSidebarCollapsed, filterSheetOpen, setFilterSheetOpen, setHasFilterSidebar } =
		usePageLayout()

	// Announce presence to the trigger, which sits in the page header and so can't see this as a
	// child. A layout effect rather than a passive one: it lands before paint, so a filtered page
	// never shows a frame with the trigger missing.
	React.useLayoutEffect(() => {
		setHasFilterSidebar(true)
		return () => setHasFilterSidebar(false)
	}, [setHasFilterSidebar])

	if (filterSidebarCollapsed) {
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
			className={cn("@container/page flex min-h-0 min-w-0 flex-1 flex-col", className)}
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

/**
 * The alternative to `ScrollArea`: a region that fills the remaining height and
 * scrolls nothing itself. Use it for a pane with its own scroller — a chat
 * transcript, a virtualized table — where an outer `overflow-auto` would produce
 * a second scrollbar and force the inner pane onto a hardcoded height.
 */
function Fill({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div data-slot="page-fill" className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
			{children}
		</div>
	)
}

/**
 * Context/detail rail on the trailing edge. Below `lg` there is no room for it
 * beside the content, so — exactly like `FilterSidebar` — it becomes a sheet
 * behind `RightSidebarTrigger` rather than disappearing.
 */
function RightSidebar({
	children,
	className,
	title = "Details",
	width = "w-72",
}: {
	children: React.ReactNode
	className?: string
	/** Accessible name for the sheet at narrow widths. */
	title?: string
	width?: string
}) {
	const { filterSidebarCollapsed, rightSheetOpen, setRightSheetOpen, setHasRightSidebar } = usePageLayout()

	// Announce presence to the trigger in the page header, which can't see this as
	// a child. Layout effect so a frame never paints with the trigger missing.
	React.useLayoutEffect(() => {
		setHasRightSidebar(true)
		return () => setHasRightSidebar(false)
	}, [setHasRightSidebar])

	if (filterSidebarCollapsed) {
		return (
			<Sheet open={rightSheetOpen} onOpenChange={setRightSheetOpen}>
				<SheetContent side="right" className="w-80 overflow-y-auto p-4">
					<SheetHeader className="sr-only">
						<SheetTitle>{title}</SheetTitle>
						<SheetDescription>Context for this page.</SheetDescription>
					</SheetHeader>
					{children}
				</SheetContent>
			</Sheet>
		)
	}

	return (
		<aside
			data-slot="page-right-sidebar"
			className={cn("hidden shrink-0 overflow-y-auto border-l lg:block", width, className)}
		>
			{children}
		</aside>
	)
}

/**
 * Opens the context sheet. Mirrors `FilterSidebarTrigger`: renders nothing unless
 * the rail has collapsed *and* a `RightSidebar` is mounted, so callers can drop it
 * in unconditionally.
 */
function RightSidebarTrigger({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) {
	const { filterSidebarCollapsed, hasRightSidebar, setRightSheetOpen } = usePageLayout()

	if (!filterSidebarCollapsed || !hasRightSidebar) return null

	return React.cloneElement(children, { onClick: () => setRightSheetOpen(true) })
}

/* -------------------------------------------------------------------------------------------------
 * FilterSidebarTrigger — button to open filter sheet on mobile
 * -------------------------------------------------------------------------------------------------*/

/**
 * Opens the filter sheet. `children` must be a single interactive element (a Button) — the click
 * handler is cloned onto it rather than wrapped around it, so the trigger stays one real button and
 * keeps its keyboard behaviour.
 *
 * Renders nothing unless the sidebar has collapsed to a sheet *and* a `FilterSidebar` is mounted to
 * open. Callers can therefore drop this in unconditionally; a page with no filters gets no button
 * rather than one that opens nothing.
 */
function FilterSidebarTrigger({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) {
	const { filterSidebarCollapsed, hasFilterSidebar, setFilterSheetOpen } = usePageLayout()

	if (!filterSidebarCollapsed || !hasFilterSidebar) return null

	return React.cloneElement(children, { onClick: () => setFilterSheetOpen(true) })
}

/* -------------------------------------------------------------------------------------------------
 * Exports
 * -------------------------------------------------------------------------------------------------*/

export const PageLayout = {
	Root,
	Header,
	HeaderActions,
	Title,
	Description,
	StickyArea,
	Body,
	FilterSidebar,
	FilterSidebarTrigger,
	Content,
	ScrollArea,
	Fill,
	RightSidebar,
	RightSidebarTrigger,
}

export { usePageLayout }
