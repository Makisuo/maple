import { type ReactNode, createElement } from "react"
import { Atom, ScopedAtom, useAtom } from "@/lib/effect-atom"

interface AutocompleteKeysState {
  activeAttributeKey: string | null
  activeResourceAttributeKey: string | null
}

const AutocompleteKeys = ScopedAtom.make((_: unknown) =>
  Atom.make<AutocompleteKeysState>({
    activeAttributeKey: null,
    activeResourceAttributeKey: null,
  }),
)

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
