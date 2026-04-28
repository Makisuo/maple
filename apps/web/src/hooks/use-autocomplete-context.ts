import { type ReactNode, createElement, use, useRef } from "react"
import { Atom, ScopedAtom, useAtom } from "@/lib/effect-atom"

interface AutocompleteKeysState {
	activeAttributeKey: string | null
	activeResourceAttributeKey: string | null
}

const defaultState: AutocompleteKeysState = {
	activeAttributeKey: null,
	activeResourceAttributeKey: null,
}

const AutocompleteKeys = ScopedAtom.make((_: unknown) => Atom.make<AutocompleteKeysState>(defaultState))

export function AutocompleteKeysProvider({ children }: { children?: ReactNode }) {
	return createElement(AutocompleteKeys.Provider, { value: undefined as never, children })
}

export function useAutocompleteContext() {
	const atom = AutocompleteKeys.use()
	const [state, setState] = useAtom(atom)

	return {
		activeAttributeKey: state.activeAttributeKey,
		activeResourceAttributeKey: state.activeResourceAttributeKey,
		setActiveAttributeKey: (key: string | null) =>
			setState((current) => ({ ...current, activeAttributeKey: key })),
		setActiveResourceAttributeKey: (key: string | null) =>
			setState((current) => ({ ...current, activeResourceAttributeKey: key })),
	}
}

/**
 * Returns the autocomplete context if inside an AutocompleteKeysProvider,
 * or null if no provider exists. Safe to call unconditionally.
 */
export function useAutocompleteContextOptional() {
	const contextAtom = use(AutocompleteKeys.Context)
	const hasProvider = contextAtom !== undefined
	const fallbackRef = useRef(Atom.make<AutocompleteKeysState>(defaultState))
	const atom = hasProvider ? contextAtom : fallbackRef.current
	const [state, setState] = useAtom(atom)

	if (!hasProvider) return null

	return {
		activeAttributeKey: state.activeAttributeKey,
		activeResourceAttributeKey: state.activeResourceAttributeKey,
		setActiveAttributeKey: (key: string | null) =>
			setState((current) => ({ ...current, activeAttributeKey: key })),
		setActiveResourceAttributeKey: (key: string | null) =>
			setState((current) => ({ ...current, activeResourceAttributeKey: key })),
	}
}
