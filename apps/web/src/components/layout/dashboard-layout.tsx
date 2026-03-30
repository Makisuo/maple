import * as React from "react"
import { Atom, useAtom } from "@/lib/effect-atom"

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
  const isScrolledAtom = React.useMemo(() => Atom.make(false), [])
  const [isScrolled, setIsScrolled] = useAtom(isScrolledAtom)
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
                        const { pathname, search } = parseSearchFromHref(item.href)
                        if (!search) {
                          return (
                            <BreadcrumbLink render={<Link to={pathname} />}>
                              {item.label}
                            </BreadcrumbLink>
                          )
                        }
                        return (
                          <BreadcrumbLink render={<Link to={pathname} search={search as never} />}>
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
          {breadcrumbActions && <div className="ml-auto shrink-0">{breadcrumbActions}</div>}
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {filterSidebar && (
            <aside className="sticky top-0 h-full w-64 max-w-[40vw] shrink-0 overflow-y-auto border-r p-4">
              {filterSidebar}
            </aside>
          )}
          <main id="main-content" className="flex min-h-0 min-w-0 flex-1 flex-col">
            {(hasHeader || stickyContent) && (
              <div className={`shrink-0 space-y-4 p-4 transition-shadow ${isScrolled ? "shadow-[0_2px_8px_rgba(0,0,0,0.08)]" : ""}`}>
                {hasHeader && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0 flex-1">
                      {titleContent ?? (
                        title && <h1 className="text-2xl font-bold tracking-tight truncate" title={title}>{title}</h1>
                      )}
                      {description && (
                        <p className="text-muted-foreground">{description}</p>
                      )}
                    </div>
                    {headerActions && <div className="shrink-0">{headerActions}</div>}
                  </div>
                )}
                {stickyContent}
              </div>
            )}
            <div
              className="flex min-h-0 flex-1 flex-col overflow-auto p-4"
              onScroll={(e) => setIsScrolled(e.currentTarget.scrollTop > 0)}
            >
              {children}
            </div>
          </main>
          {rightSidebar && <aside className="hidden lg:block">{rightSidebar}</aside>}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
