// Single source of truth for docs navigation ordering. The sidebar
// (DocsSidebar), mobile nav (DocsMobileNav), prev/next pager, and the docs
// index page all read from here so group order never drifts apart.

/** Order of doc groups in the sidebar + index page. */
export const GROUP_ORDER = ["Getting Started", "Sending Data", "Reference", "Operations"] as const
