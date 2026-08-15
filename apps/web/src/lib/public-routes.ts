/**
 * Which paths render without a session.
 *
 * Previously an exact-match `Set` duplicated in two files — `__root.tsx` (the
 * auth gate and two render gates) and `main.tsx` (the Clerk-settle wait) — which
 * had already drifted apart. Share links forced the question, since `/share/:token`
 * is parameterised and no exact set can express it.
 *
 * Deliberately dependency-free: no router, no Clerk, no app imports. `main.tsx`
 * needs it before the router exists, so anything it pulled in would be loaded
 * before the first paint of every page. (`@/lab/registry` qualifies: its only
 * import is type-level.)
 */
import { isSessionlessLabPath } from "@/lab/registry"

/**
 * Dev-only lab and bench surfaces that render without an API or a session —
 * everything under `/lab` except the entries that read real org data. See
 * `src/lab/registry.ts`.
 */
export const isFixturePath = isSessionlessLabPath

const EXACT_PUBLIC_PATHS = new Set(["/sign-in", "/sign-up", "/org-required"])

/**
 * Prefixes whose entire subtree is public.
 *
 * `/share/` covers both `/share/:token` and `/share/:token/embed`. The trailing
 * slash matters: without it, a future `/shares-admin` route would silently
 * become public.
 */
const PUBLIC_PREFIXES = ["/share/"]

export function isPublicPath(pathname: string): boolean {
	if (EXACT_PUBLIC_PATHS.has(pathname)) return true
	if (isFixturePath(pathname)) return true
	return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/**
 * A share page must not mount the app's global chrome — command palette, chat
 * sheet, route prefetch — all of which assume a signed-in org. Separate from
 * `isPublicPath` because the sign-in and fixture pages are public but are still
 * part of the app shell.
 */
export function isChromelessPath(pathname: string): boolean {
	return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
