import * as React from "react"

import type { AiSessionSpan, AiSessionSpanCursor } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"

import {
	getAiSessionSpans,
	type AiSessionSpansInput,
	type AiSessionSpansPage,
} from "@/api/warehouse/ai-sessions"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import type { SessionWindow } from "@/lib/agent-sessions/session-window"
import { Result, useAtomValue, type Atom } from "@/lib/effect-atom"
import { mapleRuntime } from "@/lib/registry"
import { logClientError } from "@/lib/services/common/telemetry"
import { aiSessionSpansResultAtom, type QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"

/**
 * One turn's app spans — the service's own HTTP/DB work sharing the agent's
 * traces — as far as they have been loaded.
 *
 * `loaded` counts spans this hook fetched for the turn, not the app spans the
 * turn holds: the first page carried every span of the session's opening, so a
 * turn inside it has its app spans without a fetch. `cursor` set means the
 * turn has more than one page of them.
 */
export interface TurnAppSpansState {
	readonly loading: boolean
	readonly loaded: number
	readonly cursor: AiSessionSpanCursor | undefined
	readonly complete: boolean
	readonly failed: boolean
}

export interface SessionSpansState {
	/** The first page — the atom's `Result`, which is what the page renders on. */
	readonly firstPage: Result.Result<AiSessionSpansPage, QueryAtomFailure>
	/** Every span loaded so far, deduplicated, in the session's own order. */
	readonly spans: readonly AiSessionSpan[]
	/**
	 * The session did not fit the first page. Every later page carries the
	 * agent's spans alone, so a turn beyond the opening shows the app's spans
	 * only once `loadAppSpans` fetched them.
	 */
	readonly partial: boolean
	/** Agent spans remain past what is loaded. */
	readonly hasMore: boolean
	readonly loadingMore: boolean
	readonly loadMore: () => void
	readonly appSpans: {
		readonly of: (turn: SessionTurn) => TurnAppSpansState | undefined
		readonly load: (turn: SessionTurn) => void
	}
}

/** Agent spans a page carries past the first: the same ceiling the first page has. */
const PAGE_SIZE = 2_000

/**
 * Slack around a turn's bounds for its app-span read. A turn past the first
 * page is bounded by its AGENT spans alone, and the server span that opened
 * the trace — the parent of the turn's own root — started before the first of
 * them. Same figure as the session window's own padding.
 */
const APP_SPANS_PADDING_MS = 60_000

/** The two reads, injectable so a test can stand in fakes for both. */
export interface SessionSpansReads {
	/** The first page — an atom, so the page keeps its skeleton/retention semantics. */
	readonly firstPageAtom: (input: AiSessionSpansInput) => Atom.Atom<Result.Result<AiSessionSpansPage, QueryAtomFailure>>
	/** Every page past the first. */
	readonly fetchPage: (data: AiSessionSpansInput) => Promise<AiSessionSpansPage>
}

const warehouseReads: SessionSpansReads = {
	firstPageAtom: (input) => aiSessionSpansResultAtom({ data: input }),
	fetchPage: (data) => mapleRuntime.runPromise(getAiSessionSpans({ data })),
}

const NO_APP_SPANS: TurnAppSpansState = {
	loading: false,
	loaded: 0,
	cursor: undefined,
	complete: false,
	failed: false,
}

/** What the hook has loaded past the first page, for one first-page input. */
interface Loaded {
	readonly key: string
	readonly pages: ReadonlyArray<AiSessionSpansPage>
	readonly appPages: ReadonlyArray<AiSessionSpansPage>
	readonly appSpans: ReadonlyMap<string, TurnAppSpansState>
	readonly loadingMore: boolean
}

// Shared empties, so the derived `loaded` below keeps its identities across
// renders while nothing has been fetched under the key — every memo downstream
// of `spans` is keyed on them.
const NO_PAGES: ReadonlyArray<AiSessionSpansPage> = []
const NO_TURNS: ReadonlyMap<string, TurnAppSpansState> = new Map()

const nothingLoaded = (key: string): Loaded => ({
	key,
	pages: NO_PAGES,
	appPages: NO_PAGES,
	appSpans: NO_TURNS,
	loadingMore: false,
})

/**
 * What a turn's app-span state is keyed by. Turn ids are derived from the
 * spans in hand and a page appended later can re-derive every one of them
 * (`buildSessionTurns` picks its anchor rule from the whole list); the span
 * that opened the turn survives that far more often than the id does.
 */
const turnKey = (turn: SessionTurn) => turn.anchor.spanId

/**
 * A session's spans, loaded in the order the reader needs them.
 *
 * The first page is the session's opening, every span of it — a session that
 * fits is complete after one read, which is the common case and the only one
 * the page used to handle. A session that does not fit continues in pages of
 * the AGENT's spans alone: the transcript is built from those, and they are a
 * fraction of a large session's rows (in production a tenth, the rest being
 * the app's own SQL and HTTP). The app's spans for a turn past the opening are
 * fetched when the reader asks for that turn, by the turn's traces and bounds.
 *
 * Pages after the first live in component state rather than in atoms: they
 * are appended to one growing list keyed by the first page's input, the way
 * the list page's `useInfiniteAiSessions` does it. A window or session change
 * drops them, because they belong to the read they extended — the key on the
 * state is what says which read that was, and a response landing after the
 * key moved on is discarded.
 */
export function useSessionSpans(
	sessionId: string,
	window: SessionWindow | undefined,
	reads: SessionSpansReads = warehouseReads,
): SessionSpansState {
	const input = React.useMemo(() => ({ sessionId, ...window }), [sessionId, window])
	const key = JSON.stringify(input)
	const firstPage = useAtomValue(reads.firstPageAtom(input))

	const [stored, setStored] = React.useState<Loaded>(() => nothingLoaded(key))
	// Derived on render rather than reset in an effect: a stale entry is simply
	// not this key's, and the first write under the new key replaces it.
	const loaded = stored.key === key ? stored : nothingLoaded(key)
	// A change for a key that is no longer current is dropped: it belongs to a
	// read the page moved on from, and writing it would wipe the current key's.
	const update = React.useCallback(
		(forKey: string, change: (previous: Loaded) => Loaded) =>
			setStored((previous) => {
				const current = previous.key === forKey ? previous : key === forKey ? nothingLoaded(forKey) : undefined
				return current === undefined ? previous : change(current)
			}),
		[key],
	)

	const firstCursor = Result.isSuccess(firstPage) ? firstPage.value.nextCursor : undefined
	const lastCursor = loaded.pages.length > 0 ? loaded.pages[loaded.pages.length - 1]!.nextCursor : firstCursor
	const partial = firstCursor !== undefined
	const hasMore = lastCursor !== undefined

	const spans = React.useMemo(() => {
		const first = Result.isSuccess(firstPage) ? firstPage.value.data : []
		return dedupeInOrder([
			...first,
			...loaded.pages.flatMap((page) => page.data),
			...loaded.appPages.flatMap((page) => page.data),
		])
	}, [firstPage, loaded.pages, loaded.appPages])

	const loadMore = React.useCallback(() => {
		if (loaded.loadingMore || lastCursor === undefined) return
		update(key, (previous) => ({ ...previous, loadingMore: true }))
		reads
			.fetchPage({ ...input, scope: "ai", after: lastCursor, limit: PAGE_SIZE })
			.then((page) => {
				update(key, (previous) => ({ ...previous, pages: [...previous.pages, page], loadingMore: false }))
			})
			.catch((error: unknown) => {
				logClientError("ai_session.pagination_failed", error)
				update(key, (previous) => ({ ...previous, loadingMore: false }))
			})
	}, [reads, input, key, lastCursor, loaded.loadingMore, update])

	const loadAppSpans = React.useCallback(
		(turn: SessionTurn) => {
			const id = turnKey(turn)
			const state = loaded.appSpans.get(id) ?? NO_APP_SPANS
			if (state.loading || state.complete) return
			const setTurn = (next: TurnAppSpansState) =>
				update(key, (previous) => ({ ...previous, appSpans: new Map(previous.appSpans).set(id, next) }))
			setTurn({ ...state, loading: true, failed: false })
			reads
				.fetchPage({
					sessionId,
					startTime: formatWarehouseDateTime(turn.startMs - APP_SPANS_PADDING_MS),
					endTime: formatWarehouseDateTime(turn.endMs + APP_SPANS_PADDING_MS),
					traceIds: turn.traceIds,
					scope: "app",
					limit: PAGE_SIZE,
					...(state.cursor !== undefined && { after: state.cursor }),
				})
				.then((page) => {
					update(key, (previous) => ({
						...previous,
						appPages: [...previous.appPages, page],
						appSpans: new Map(previous.appSpans).set(id, {
							loading: false,
							loaded: state.loaded + page.data.length,
							cursor: page.nextCursor,
							complete: page.nextCursor === undefined,
							failed: false,
						}),
					}))
				})
				.catch((error: unknown) => {
					logClientError("ai_session.app_spans_failed", error)
					setTurn({ ...state, loading: false, failed: true })
				})
		},
		[reads, key, loaded.appSpans, sessionId, update],
	)

	const of = React.useCallback((turn: SessionTurn) => loaded.appSpans.get(turnKey(turn)), [loaded.appSpans])

	return {
		firstPage,
		spans,
		partial,
		hasMore,
		loadingMore: loaded.loadingMore,
		loadMore,
		appSpans: { of, load: loadAppSpans },
	}
}

/**
 * Later pages never repeat a span, but a turn's app-span read can: the first
 * page carried the session's opening whole, so a turn straddling its end has
 * some app spans twice. First occurrence wins, and the session's order — the
 * page order — is kept, since every consumer sorts by start time anyway.
 */
function dedupeInOrder(spans: readonly AiSessionSpan[]): readonly AiSessionSpan[] {
	const seen = new Set<string>()
	const kept: AiSessionSpan[] = []
	for (const span of spans) {
		if (seen.has(span.spanId)) continue
		seen.add(span.spanId)
		kept.push(span)
	}
	return kept
}
