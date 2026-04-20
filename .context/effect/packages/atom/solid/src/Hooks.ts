/**
 * @since 1.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import type * as AtomRef from "effect/unstable/reactivity/AtomRef"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import type { Accessor, ResourceOptions, ResourceReturn } from "solid-js"
import { createComputed, createEffect, createMemo, createResource, createSignal, onCleanup, useContext } from "solid-js"
import { RegistryContext } from "./RegistryContext.ts"

const initialValuesSet = new WeakMap<AtomRegistry.AtomRegistry, WeakSet<Atom.Atom<any>>>()

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomInitialValues = (initialValues: Iterable<readonly [Atom.Atom<any>, any]>): void => {
  const registry = useContext(RegistryContext)
  let set = initialValuesSet.get(registry)
  if (set === undefined) {
    set = new WeakSet()
    initialValuesSet.set(registry, set)
  }
  for (const [atom, value] of initialValues) {
    if (!set.has(atom)) {
      set.add(atom)
      ;(registry as any).ensureNode(atom).setValue(value)
    }
  }
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomValue: {
  <A>(atom: () => Atom.Atom<A>): Accessor<A>
  <A, B>(atom: () => Atom.Atom<A>, f: (_: A) => B): Accessor<B>
} = <A>(atom: () => Atom.Atom<A>, f?: (_: A) => A): Accessor<A> => {
  const registry = useContext(RegistryContext)
  return createAtomAccessor(registry, f ? () => Atom.map(atom(), f) : atom)
}

function createAtomAccessor<A>(registry: AtomRegistry.AtomRegistry, atom: () => Atom.Atom<A>): Accessor<A> {
  const [value, setValue] = createSignal<A>(null as any)
  createComputed(() => {
    onCleanup(registry.subscribe(atom(), setValue as any, constImmediate))
  })
  return value
}

const constImmediate = { immediate: true }

function mountAtom<A>(registry: AtomRegistry.AtomRegistry, atom: () => Atom.Atom<A>): void {
  createComputed(() => {
    onCleanup(registry.mount(atom()))
  })
}

function setAtom<R, W, Mode extends "value" | "promise" | "promiseExit" = never>(
  registry: AtomRegistry.AtomRegistry,
  atom: () => Atom.Writable<R, W>,
  options?: {
    readonly mode?: ([R] extends [AsyncResult.AsyncResult<any, any>] ? Mode : "value") | undefined
  }
): "promise" extends Mode ? (
    (value: W) => Promise<AsyncResult.AsyncResult.Success<R>>
  ) :
  "promiseExit" extends Mode ? (
      (value: W) => Promise<Exit.Exit<AsyncResult.AsyncResult.Success<R>, AsyncResult.AsyncResult.Failure<R>>>
    ) :
  ((value: W | ((value: R) => W)) => void)
{
  const memo = createMemo(atom)
  if (options?.mode === "promise" || options?.mode === "promiseExit") {
    return ((value: W) => {
      registry.set(memo(), value)
      const promise = Effect.runPromiseExit(
        AtomRegistry.getResult(registry, memo() as Atom.Atom<AsyncResult.AsyncResult<any, any>>, {
          suspendOnWaiting: true
        })
      )
      return options!.mode === "promise" ? promise.then(flattenExit) : promise
    }) as any
  }
  return ((value: W | ((value: R) => W)) => {
    registry.set(memo(), typeof value === "function" ? (value as any)(registry.get(memo())) : value)
  }) as any
}

const flattenExit = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomMount = <A>(atom: () => Atom.Atom<A>): void => {
  const registry = useContext(RegistryContext)
  mountAtom(registry, atom)
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomSet = <
  R,
  W,
  Mode extends "value" | "promise" | "promiseExit" = never
>(
  atom: () => Atom.Writable<R, W>,
  options?: {
    readonly mode?: ([R] extends [AsyncResult.AsyncResult<any, any>] ? Mode : "value") | undefined
  }
): "promise" extends Mode ? (
    (value: W) => Promise<AsyncResult.AsyncResult.Success<R>>
  ) :
  "promiseExit" extends Mode ? (
      (value: W) => Promise<Exit.Exit<AsyncResult.AsyncResult.Success<R>, AsyncResult.AsyncResult.Failure<R>>>
    ) :
  ((value: W | ((value: R) => W)) => void) =>
{
  const registry = useContext(RegistryContext)
  mountAtom(registry, atom)
  return setAtom(registry, atom, options)
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomRefresh = <A>(atom: () => Atom.Atom<A>): () => void => {
  const registry = useContext(RegistryContext)
  mountAtom(registry, atom)
  const memo = createMemo(atom)
  return () => registry.refresh(memo())
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtom = <R, W, const Mode extends "value" | "promise" | "promiseExit" = never>(
  atom: () => Atom.Writable<R, W>,
  options?: {
    readonly mode?: ([R] extends [AsyncResult.AsyncResult<any, any>] ? Mode : "value") | undefined
  }
): readonly [
  value: Accessor<R>,
  write: "promise" extends Mode ? (
      (value: W) => Promise<AsyncResult.AsyncResult.Success<R>>
    ) :
    "promiseExit" extends Mode ? (
        (value: W) => Promise<Exit.Exit<AsyncResult.AsyncResult.Success<R>, AsyncResult.AsyncResult.Failure<R>>>
      ) :
    ((value: W | ((value: R) => W)) => void)
] => {
  const registry = useContext(RegistryContext)
  return [
    createAtomAccessor(registry, atom),
    setAtom(registry, atom, options)
  ] as const
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomSubscribe = <A>(
  atom: () => Atom.Atom<A>,
  f: (_: A) => void,
  options?: { readonly immediate?: boolean }
): void => {
  const registry = useContext(RegistryContext)
  createEffect(() => {
    onCleanup(registry.subscribe(atom(), f, options))
  })
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomResource = <A, E>(
  atom: () => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: ResourceOptions<A> & {
    readonly suspendOnWaiting?: boolean | undefined
  }
): ResourceReturn<A, void> => {
  const result = useAtomValue(atom)
  return createResource(result, (result) => {
    if (AsyncResult.isInitial(result) || (options?.suspendOnWaiting && result.waiting)) {
      return constUnresolvedPromise
    } else if (AsyncResult.isSuccess(result)) {
      return Promise.resolve(result.value)
    }
    return Promise.reject(Cause.squash(result.cause))
  })
}

const constUnresolvedPromise = new Promise<never>(() => {})

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomRef = <A>(ref: () => AtomRef.ReadonlyRef<A>): Accessor<A> => {
  const [value, setValue] = createSignal(null as A)
  createComputed(() => {
    const r = ref()
    setValue(r.value as any)
    onCleanup(r.subscribe(setValue))
  })
  return value
}

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomRefProp = <A, K extends keyof A>(
  ref: () => AtomRef.AtomRef<A>,
  prop: K
): Accessor<AtomRef.AtomRef<A[K]>> => createMemo(() => ref().prop(prop))

/**
 * @since 1.0.0
 * @category hooks
 */
export const useAtomRefPropValue = <A, K extends keyof A>(ref: () => AtomRef.AtomRef<A>, prop: K): Accessor<A[K]> =>
  useAtomRef(useAtomRefProp(ref, prop))
