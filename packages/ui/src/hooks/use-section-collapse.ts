"use client"

import * as React from "react"
import { Option, Schema } from "effect"

import { readLocalStorage, writeLocalStorage } from "../lib/local-storage"

/**
 * Remembered open/closed state for one collapsible filter section.
 *
 * Collapse was component-local `useState`, so every section snapped back to its
 * default on remount — open a histogram, navigate to a session, come back, and
 * it is shut again. Nothing you did to the rail survived, which is most of why
 * it read as "always collapsed".
 *
 * Only sections you have actually toggled are written. A key that was never
 * touched falls through to the caller's `defaultOpen`, so changing a default
 * later still reaches everyone who never expressed a preference.
 */
const STORAGE_KEY = "maple-filter-sections"

/** Section key → open. Parsed at the localStorage boundary, so a hand-edited or
 *  stale entry degrades to "no preference" rather than to a crashed sidebar. */
const SectionState = Schema.Record(Schema.String, Schema.Boolean)
type SectionState = typeof SectionState.Type

const decodeSectionState = Schema.decodeUnknownOption(Schema.fromJsonString(SectionState))

function read(): SectionState {
	// Unavailable storage and an unreadable entry are the same answer here: no
	// preference, so every section falls back to the caller's default.
	const stored = Option.flatMap(readLocalStorage(STORAGE_KEY), decodeSectionState)
	return Option.getOrElse(stored, (): SectionState => ({}))
}

function write(key: string, open: boolean): void {
	writeLocalStorage(STORAGE_KEY, JSON.stringify({ ...read(), [key]: open }))
}

/**
 * `key` is the section title by default, which means a section named "Service"
 * shares its state across every sidebar that has one. That is deliberate: the
 * preference being expressed is "I don't care about service right now", and it
 * is the same preference on /traces as on /replays. Pass an explicit key only
 * where two same-titled sections genuinely mean different things.
 */
export function useSectionCollapse(key: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
	const [isOpen, setIsOpen] = React.useState(() => read()[key] ?? defaultOpen)

	const setOpen = React.useCallback(
		(open: boolean) => {
			setIsOpen(open)
			write(key, open)
		},
		[key],
	)

	return [isOpen, setOpen]
}
