/**
 * @since 1.0.0
 */
"use client"

import type * as Atom from "effect/unstable/reactivity/Atom"
import * as React from "react"

/**
 * @since 1.0.0
 * @category Type IDs
 *
 * Type identifier for ScopedAtom.
 */
export type TypeId = "~@effect/atom-react/ScopedAtom"

/**
 * @since 1.0.0
 * @category Type IDs
 *
 * Type identifier for ScopedAtom.
 */
export const TypeId: TypeId = "~@effect/atom-react/ScopedAtom"

/**
 * @since 1.0.0
 * @category models
 *
 * Scoped Atom interface with a provider-backed instance.
 *
 * @example
 * ```ts
 * import * as Atom from "effect/unstable/reactivity/Atom"
 * import * as React from "react"
 * import * as ScopedAtom from "@effect/atom-react/ScopedAtom"
 * import { useAtomValue } from "@effect/atom-react"
 *
 * const Counter = ScopedAtom.make(() => Atom.make(0))
 *
 * function View() {
 *   const atom = Counter.use()
 *   const value = useAtomValue(atom)
 *   return React.createElement("div", null, value)
 * }
 *
 * export function App() {
 *   return React.createElement(Counter.Provider, null, React.createElement(View))
 * }
 * ```
 */
export interface ScopedAtom<A extends Atom.Atom<any>, Input = never> {
  readonly [TypeId]: TypeId
  use(): A
  Provider: Input extends never ? React.FC<{ readonly children?: React.ReactNode | undefined }>
    : React.FC<{ readonly children?: React.ReactNode | undefined; readonly value: Input }>
  Context: React.Context<A>
}

/**
 * @since 1.0.0
 * @category constructors
 *
 * Creates a ScopedAtom from a factory function.
 *
 * @example
 * ```ts
 * import * as Atom from "effect/unstable/reactivity/Atom"
 * import * as React from "react"
 * import * as ScopedAtom from "@effect/atom-react/ScopedAtom"
 * import { useAtomValue } from "@effect/atom-react"
 *
 * const User = ScopedAtom.make((name: string) => Atom.make(name))
 *
 * function UserName() {
 *   const atom = User.use()
 *   const value = useAtomValue(atom)
 *   return React.createElement("span", null, value)
 * }
 *
 * export function App() {
 *   return React.createElement(
 *     User.Provider,
 *     { value: "Ada" },
 *     React.createElement(UserName)
 *   )
 * }
 * ```
 */
export const make = <A extends Atom.Atom<any>, Input = never>(
  f: (() => A) | ((input: Input) => A)
): ScopedAtom<A, Input> => {
  const Context = React.createContext<A>(undefined as unknown as A)

  const use = (): A => {
    const atom = React.useContext(Context)
    if (atom === undefined) {
      throw new Error("ScopedAtom used outside of its Provider")
    }
    return atom
  }

  const Provider: React.FC<{ readonly children?: React.ReactNode | undefined; readonly value?: Input }> = (props) => {
    const atom = React.useRef<A | null>(null)
    if (atom.current === null) {
      if ("value" in props) {
        atom.current = (f as (input: Input) => A)(props.value as Input)
      } else {
        atom.current = (f as () => A)()
      }
    }
    return React.createElement(Context.Provider, { value: atom.current }, props.children)
  }

  return {
    [TypeId]: TypeId,
    use,
    Provider: Provider as any,
    Context
  }
}
