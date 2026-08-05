"use client"

import * as React from "react"

/**
 * Tracks whether a Base UI `Menu.Group` is above us in the tree.
 *
 * Base UI's `Menu.GroupLabel` throws `MenuGroupContext is missing` (production
 * error #31, a full error-boundary crash) unless a `Menu.Group` wraps it, and it
 * does not export the context we'd need to detect that ourselves. So the menu
 * label wrappers keep this parallel flag and self-wrap in a `Menu.Group` when
 * nothing above them provided one.
 *
 * Detecting rather than always wrapping matters: a nested `Menu.Group` would
 * capture the label's id, so the real enclosing group would lose its
 * `aria-labelledby`.
 *
 * Shared by `dropdown-menu` and `context-menu` because `@base-ui/react/context-menu`
 * re-exports the very same `MenuGroup` / `MenuGroupLabel` parts.
 */
export const InMenuGroupContext: React.Context<boolean> = React.createContext(false)

export function useInMenuGroup(): boolean {
	return React.useContext(InMenuGroupContext)
}
