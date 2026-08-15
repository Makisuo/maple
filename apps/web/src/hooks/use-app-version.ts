import * as React from "react"
import * as Predicate from "effect/Predicate"

import { useMountEffect } from "@/hooks/use-mount-effect"

/** Slow on purpose — a deploy the user learns about 15 minutes late costs nothing. */
const POLL_INTERVAL_MS = 15 * 60 * 1000

/**
 * The commit this bundle was built from, baked in by Vite's `define`.
 *
 * Empty for any build that is not a deploy (local dev, tests, previews), which
 * is the switch that makes this whole check inert there.
 */
const BUILT_COMMIT: string = import.meta.env.VITE_COMMIT_SHA ?? ""

const fetchDeployedCommit = async (): Promise<string | null> => {
	try {
		// Cache-busted twice over. `no-store` handles the browser's HTTP cache and
		// the query param handles any edge or proxy cache that keys on URL alone —
		// a poll answered from cache reports the deploy this tab is already running,
		// which is precisely the failure this function exists to avoid.
		const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" })
		if (!response.ok) return null
		const body: unknown = await response.json()
		if (!Predicate.isObject(body)) return null
		const commit = body.commit
		return Predicate.isString(commit) && commit.length > 0 ? commit : null
	} catch {
		// Offline, or a deploy swapping assets underneath us. Either way this is a
		// best-effort background probe: staying quiet and trying again on the next
		// tick is strictly better than surfacing a network error for something the
		// user never asked for.
		return null
	}
}

/**
 * True once the server is serving a different build than this tab is running.
 *
 * Exists because a long-lived tab has no other reason to reload. The app already
 * recovers from a *stale chunk* (`lib/chunk-reload.ts`), but only reactively —
 * after a navigation has already failed. That leaves a tab that never navigates
 * running arbitrarily old JS against a moving API, which is a real correctness
 * problem during a stored-schema rollout: `apps/web/src/lib/collections/dashboards.ts`
 * migrates dashboard documents client-side, so a tab whose bundle predates a
 * schema version cannot read documents written in it.
 *
 * Never auto-reloads. A dashboard being edited has unsaved state in memory, and
 * silently discarding it to save the user one click is a bad trade. The banner
 * asks; the user picks the moment.
 *
 * Latches: once a newer deploy is seen it stays seen, even if a subsequent poll
 * fails or a rollback restores the original commit. The tab has already been
 * told it is behind, and flickering the banner away would be worse than leaving
 * a reload prompt up for a build that is once again current.
 */
export function useAppVersionChanged(): boolean {
	const [changed, setChanged] = React.useState(false)

	useMountEffect(() => {
		if (BUILT_COMMIT.length === 0) return

		let cancelled = false
		let timeout: ReturnType<typeof setTimeout> | undefined

		const probe = async () => {
			if (cancelled || document.hidden) return
			const deployed = await fetchDeployedCommit()
			if (cancelled || deployed === null) return
			if (deployed !== BUILT_COMMIT) setChanged(true)
		}

		const schedule = () => {
			timeout = setTimeout(() => {
				void probe()
				schedule()
			}, POLL_INTERVAL_MS)
		}

		// The event that actually matters. The tab this is written for has been
		// hidden for hours or days; it learns it is stale the moment someone looks
		// at it, not up to a poll interval later.
		const onVisibilityChange = () => {
			if (!document.hidden) void probe()
		}

		document.addEventListener("visibilitychange", onVisibilityChange)
		schedule()

		return () => {
			cancelled = true
			document.removeEventListener("visibilitychange", onVisibilityChange)
			if (timeout !== undefined) clearTimeout(timeout)
		}
	})

	return changed
}
