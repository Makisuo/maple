import { type ReactNode, useMemo } from "react"

import { Atom, Result, useAtomValue } from "@/lib/effect-atom"

import { commitQueryAtom, firstLine, isResolvableSha } from "../commit-sha-hover-card"
import { CommitMarkersLayer } from "./commit-markers-layer"
import { buildCommitMarkers, type ReleasePoint } from "./marker-layout"

/**
 * Derives commit deploy markers from the release timeline and returns the chart
 * `overlay` element. A marker's label defaults to its representative commit's SHA
 * (short sha / tag); here we swap that for the commit message subject when the
 * per-SHA query resolves. A single derived atom (`markersAtom`) reads each
 * resolvable marker's `commitQueryAtom(sha)` — subscribing to it both drives the
 * relabel and primes the shared cache, so opening the hover card is a cache hit
 * (no null-rendering subscriber components needed).
 */
export function useCommitMarkers(
	releases: ReadonlyArray<ReleasePoint>,
	chartBuckets: ReadonlyArray<string>,
): ReactNode {
	const baseMarkers = useMemo(() => buildCommitMarkers(releases, chartBuckets), [releases, chartBuckets])

	// Read the per-SHA commit query for each resolvable marker and, on success,
	// relabel it with the message subject. `get(commitQueryAtom(sha))` subscribes,
	// so the atom re-derives as each query resolves — and priming that same memoized
	// query is what makes the hover card open onto a cache hit. Only resolvable SHAs
	// hit the backend (`isResolvableSha` guard); everything else keeps its default
	// label. A resolved-but-empty subject falls back to the original label.
	const markersAtom = useMemo(
		() =>
			Atom.make((get) =>
				baseMarkers.map((m) => {
					const sha = m.commits[0]?.sha
					if (!sha || !isResolvableSha(sha)) return m
					const label = Result.builder(get(commitQueryAtom(sha)))
						.onSuccess((c) => firstLine(c.message))
						.orElse(() => null)
					return label ? { ...m, label } : m
				}),
			),
		[baseMarkers],
	)
	const markers = useAtomValue(markersAtom)

	return markers.length > 0 ? <CommitMarkersLayer markers={markers} /> : null
}
