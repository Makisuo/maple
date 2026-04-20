/**
 * @since 1.0.0
 */
"use client"

import type * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import * as React from "react"
import * as Scheduler from "scheduler"

/**
 * @since 1.0.0
 * @category context
 */
export function scheduleTask(f: () => void): () => void {
  const node = Scheduler.unstable_scheduleCallback(Scheduler.unstable_LowPriority, f)
  return () => Scheduler.unstable_cancelCallback(node)
}

/**
 * @since 1.0.0
 * @category context
 */
export const RegistryContext = React.createContext<AtomRegistry.AtomRegistry>(AtomRegistry.make({
  scheduleTask,
  defaultIdleTTL: 400
}))

/**
 * @since 1.0.0
 * @category context
 */
export const RegistryProvider = (options: {
  readonly children?: React.ReactNode | undefined
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]> | undefined
  readonly scheduleTask?: ((f: () => void) => () => void) | undefined
  readonly timeoutResolution?: number | undefined
  readonly defaultIdleTTL?: number | undefined
}) => {
  const ref = React.useRef<{
    readonly registry: AtomRegistry.AtomRegistry
    timeout?: number | undefined
  }>(null)
  if (ref.current === null) {
    ref.current = {
      registry: AtomRegistry.make({
        scheduleTask: options.scheduleTask ?? scheduleTask,
        initialValues: options.initialValues,
        timeoutResolution: options.timeoutResolution,
        defaultIdleTTL: options.defaultIdleTTL
      })
    }
  }
  React.useEffect(() => {
    if (ref.current?.timeout !== undefined) {
      clearTimeout(ref.current.timeout)
    }
    return () => {
      ref.current!.timeout = setTimeout(() => {
        ref.current?.registry.dispose()
        ref.current = null
      }, 500) as any
    }
  }, [ref])
  return React.createElement(RegistryContext.Provider, { value: ref.current.registry }, options?.children)
}
