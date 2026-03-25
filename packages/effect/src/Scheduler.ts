/**
 * @since 2.0.0
 */
import type * as Fiber from "./Fiber.ts"
import * as ServiceMap from "./ServiceMap.ts"

/**
 * A scheduler manages the execution of Effects by controlling when and how tasks
 * are scheduled and executed. It determines the execution mode (synchronous or
 * asynchronous) and handles task prioritization and yielding behavior.
 *
 * The scheduler is responsible for:
 * - Scheduling tasks with different priorities
 * - Determining when fibers should yield control
 * - Managing the execution flow of Effects
 *
 * @since 2.0.0
 * @category models
 */
export interface Scheduler {
  readonly executionMode: "sync" | "async"
  shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean
  makeDispatcher(): SchedulerDispatcher
}

/**
 * @since 4.0.0
 * @category models
 */
export interface SchedulerDispatcher {
  scheduleTask(task: () => void, priority: number): void
  flush(): void
}

/**
 * @since 4.0.0
 * @category references
 */
export const Scheduler: ServiceMap.Reference<Scheduler> = ServiceMap.Reference<Scheduler>("effect/Scheduler", {
  defaultValue: () => new MixedScheduler()
})

const setImmediate = "setImmediate" in globalThis
  ? (f: () => void) => {
    // @ts-ignore
    const timer = globalThis.setImmediate(f)
    // @ts-ignore
    return (): void => globalThis.clearImmediate(timer)
  }
  : (f: () => void) => {
    const timer = setTimeout(f, 0)
    return (): void => clearTimeout(timer)
  }

class PriorityBuckets {
  buckets: Array<[priority: number, tasks: Array<() => void>]> = []

  scheduleTask(task: () => void, priority: number): void {
    const buckets = this.buckets
    const len = buckets.length
    let bucket: [number, Array<() => void>] | undefined
    let index = 0
    for (; index < len; index++) {
      if (buckets[index][0] > priority) break
      bucket = buckets[index]
    }
    if (bucket && bucket[0] === priority) {
      bucket[1].push(task)
    } else if (index === len) {
      buckets.push([priority, [task]])
    } else {
      buckets.splice(index, 0, [priority, [task]])
    }
  }

  drain() {
    const buckets = this.buckets
    this.buckets = []
    return buckets
  }
}

/**
 * A scheduler implementation that provides efficient task scheduling
 * with support for both synchronous and asynchronous execution modes.
 *
 * Features:
 * - Batches tasks for efficient execution
 * - Supports priority-based task scheduling
 * - Configurable execution mode (sync/async)
 * - Automatic yielding based on operation count
 * - Optimized for high-throughput scenarios
 *
 * @since 2.0.0
 * @category schedulers
 */
export class MixedScheduler implements Scheduler {
  readonly executionMode: "sync" | "async"
  readonly setImmediate: (f: () => void) => () => void

  constructor(
    executionMode: "sync" | "async" = "async",
    setImmediateFn: (f: () => void) => () => void = setImmediate
  ) {
    this.executionMode = executionMode
    this.setImmediate = setImmediateFn
  }

  /**
   * @since 2.0.0
   */
  shouldYield(fiber: Fiber.Fiber<unknown, unknown>) {
    return fiber.currentOpCount >= fiber.maxOpsBeforeYield
  }

  /**
   * @since 2.0.0
   */
  makeDispatcher() {
    return new MixedSchedulerDispatcher(this.setImmediate)
  }
}

class MixedSchedulerDispatcher implements SchedulerDispatcher {
  private tasks = new PriorityBuckets()
  private running: (() => void) | undefined = undefined
  readonly setImmediate: (f: () => void) => () => void

  constructor(
    setImmediateFn: (f: () => void) => () => void = setImmediate
  ) {
    this.setImmediate = setImmediateFn
  }

  /**
   * @since 2.0.0
   */
  scheduleTask(task: () => void, priority: number) {
    this.tasks.scheduleTask(task, priority)
    if (this.running === undefined) {
      this.running = this.setImmediate(this.afterScheduled)
    }
  }

  /**
   * @since 2.0.0
   */
  afterScheduled = () => {
    this.running = undefined
    this.runTasks()
  }

  /**
   * @since 2.0.0
   */
  runTasks() {
    const buckets = this.tasks.drain()
    for (let i = 0; i < buckets.length; i++) {
      const toRun = buckets[i][1]
      for (let j = 0; j < toRun.length; j++) {
        toRun[j]()
      }
    }
  }

  /**
   * @since 2.0.0
   */
  flush() {
    while (this.tasks.buckets.length > 0) {
      if (this.running !== undefined) {
        this.running()
        this.running = undefined
      }
      this.runTasks()
    }
  }
}

/**
 * A service reference that controls the maximum number of operations a fiber
 * can perform before yielding control back to the scheduler. This helps
 * prevent long-running fibers from monopolizing the execution thread.
 *
 * The default value is 2048 operations, which provides a good balance between
 * performance and fairness in concurrent execution.
 *
 * @since 4.0.0
 * @category references
 */
export const MaxOpsBeforeYield = ServiceMap.Reference<number>("effect/Scheduler/MaxOpsBeforeYield", {
  defaultValue: () => 2048
})

/**
 * A service reference that controls whether the runtime should bypass scheduler
 * yield checks. When set to `true`, the fiber run loop won't call
 * `Scheduler.shouldYield`.
 *
 * @since 4.0.0
 * @category references
 */
export const PreventSchedulerYield = ServiceMap.Reference<boolean>("effect/Scheduler/PreventSchedulerYield", {
  defaultValue: () => false
})
