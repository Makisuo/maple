/**
 * @since 4.0.0
 */
import * as Effect from "../../Effect.ts"
import * as FiberMap from "../../FiberMap.ts"
import { identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import type { Pipeable } from "../../Pipeable.ts"
import { pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as PubSub from "../../PubSub.ts"
import * as Queue from "../../Queue.ts"
import type * as Record from "../../Record.ts"
import * as Redacted from "../../Redacted.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as Semaphore from "../../Semaphore.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type { Covariant } from "../../Types.ts"
import { Reactivity } from "../reactivity/Reactivity.ts"
import * as ReactivityLayer from "../reactivity/Reactivity.ts"
import * as Event from "./Event.ts"
import type * as EventGroup from "./EventGroup.ts"
import {
  Entry,
  EventJournal,
  type EventJournalError,
  makeEntryIdUnsafe,
  type RemoteEntry,
  type RemoteId
} from "./EventJournal.ts"
import type { EventLogRemote } from "./EventLogRemote.ts"

/**
 * @since 4.0.0
 * @category schema
 */
export type SchemaTypeId = "~effect/eventlog/EventLog/Schema"

/**
 * @since 4.0.0
 * @category schema
 */
export const SchemaTypeId: SchemaTypeId = "~effect/eventlog/EventLog/Schema"

/**
 * @since 4.0.0
 * @category schema
 */
export const isEventLogSchema = (u: unknown): u is EventLogSchema<EventGroup.Any> =>
  Predicate.hasProperty(u, SchemaTypeId)

/**
 * @since 4.0.0
 * @category schema
 */
export interface EventLogSchema<Groups extends EventGroup.Any> {
  readonly [SchemaTypeId]: SchemaTypeId
  readonly groups: ReadonlyArray<Groups>
}

/**
 * @since 4.0.0
 * @category schema
 */
export const schema = <Groups extends ReadonlyArray<EventGroup.Any>>(
  ...groups: Groups
): EventLogSchema<Groups[number]> => {
  const EventLog = Object.assign(function EventLog() {}, {
    [SchemaTypeId]: SchemaTypeId,
    groups
  }) satisfies EventLogSchema<Groups[number]>
  return EventLog
}

/**
 * @since 4.0.0
 * @category handlers
 */
export type HandlersTypeId = "~effect/eventlog/EventLog/Handlers"

/**
 * @since 4.0.0
 * @category handlers
 */
export const HandlersTypeId: HandlersTypeId = "~effect/eventlog/EventLog/Handlers"

/**
 * Represents a handled `EventGroup`.
 *
 * @since 4.0.0
 * @category handlers
 */
export interface Handlers<
  R,
  Events extends Event.Any = never
> extends Pipeable {
  readonly [HandlersTypeId]: {
    _Events: Covariant<Events>
  }
  readonly group: EventGroup.AnyWithProps
  readonly handlers: Record.ReadonlyRecord<string, Handlers.Item<R>>
  readonly services: ServiceMap.ServiceMap<R>

  /**
   * Add the implementation for an `Event` to a `Handlers` group.
   */
  handle<Tag extends Event.Tag<Events>, R1>(
    name: Tag,
    handler: (
      options: {
        readonly payload: Event.PayloadWithTag<Events, Tag>
        readonly entry: Entry
        readonly conflicts: ReadonlyArray<{
          readonly entry: Entry
          readonly payload: Event.PayloadWithTag<Events, Tag>
        }>
      }
    ) => Effect.Effect<Event.SuccessWithTag<Events, Tag>, Event.ErrorWithTag<Events, Tag>, R1>
  ): Handlers<
    R | R1,
    Event.ExcludeTag<Events, Tag>
  >
}

/**
 * @since 4.0.0
 * @category handlers
 */
export declare namespace Handlers {
  /**
   * @since 4.0.0
   * @category handlers
   */
  export interface Any {
    readonly [HandlersTypeId]: unknown
  }

  /**
   * @since 4.0.0
   * @category handlers
   */
  export type Item<R> = {
    readonly event: Event.AnyWithProps
    readonly services: ServiceMap.ServiceMap<R>
    readonly handler: (options: {
      readonly payload: unknown
      readonly entry: Entry
      readonly conflicts: ReadonlyArray<{
        readonly entry: Entry
        readonly payload: unknown
      }>
    }) => Effect.Effect<unknown, unknown, R>
  }

  /**
   * @since 4.0.0
   * @category handlers
   */
  export type ValidateReturn<A> = A extends (
    | Handlers<
      infer _R,
      infer _Events
    >
    | Effect.Effect<
      Handlers<
        infer _R,
        infer _Events
      >,
      infer _EX,
      infer _RX
    >
  ) ? [_Events] extends [never] ? A
    : `Event not handled: ${Event.Tag<_Events>}` :
    `Must return the implemented handlers`

  /**
   * @since 4.0.0
   * @category handlers
   */
  export type Error<A> = A extends Effect.Effect<
    Handlers<
      infer _R,
      infer _Events
    >,
    infer _EX,
    infer _RX
  > ? _EX :
    never

  /**
   * @since 4.0.0
   * @category handlers
   */
  export type Services<A> = A extends Handlers<
    infer _R,
    infer _Events
  > ? _R | Event.Services<_Events> :
    A extends Effect.Effect<
      Handlers<
        infer _R,
        infer _Events
      >,
      infer _EX,
      infer _RX
    > ? _R | _RX | Event.Services<_Events> :
    never
}

/**
 * @since 4.0.0
 * @category models
 */
export class Identity extends ServiceMap.Service<Identity, {
  readonly publicKey: string
  readonly privateKey: Redacted.Redacted<Uint8Array>
}>()("effect/eventlog/EventLog/Identity") {}

/**
 * @since 4.0.0
 * @category schema
 */
export const IdentitySchema = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.Redacted(Schema.Uint8ArrayFromBase64)
})

const IdentityEncodedSchema = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.Uint8ArrayFromBase64
})

const IdentityStringSchema = Schema.fromJsonString(IdentityEncodedSchema)

/**
 * @since 4.0.0
 * @category constructors
 */
export const decodeIdentityString = (value: string): Identity["Service"] => {
  const decoded = Schema.decodeUnknownSync(IdentityStringSchema)(value)
  return {
    publicKey: decoded.publicKey,
    privateKey: Redacted.make(decoded.privateKey)
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const encodeIdentityString = (identity: Identity["Service"]): string =>
  Schema.encodeSync(IdentityStringSchema)({
    publicKey: identity.publicKey,
    privateKey: Redacted.value(identity.privateKey)
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeIdentityUnsafe = (): Identity["Service"] => ({
  publicKey: globalThis.crypto.randomUUID(),
  privateKey: Redacted.make(globalThis.crypto.getRandomValues(new Uint8Array(32)))
})

const handlersProto = {
  [HandlersTypeId]: {
    _Events: identity
  },
  handle<Tag extends string, R1>(
    this: Handlers<any, any>,
    tag: Tag,
    handler: (payload: unknown) => Effect.Effect<unknown, unknown, R1>
  ): Handlers<any, any> {
    return makeHandlers({
      group: this.group,
      services: this.services,
      handlers: {
        ...this.handlers,
        [tag]: {
          event: this.group.events[tag],
          services: this.services,
          handler
        }
      }
    })
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeHandlers = (options: {
  readonly group: EventGroup.AnyWithProps
  readonly handlers: Record.ReadonlyRecord<string, Handlers.Item<any>>
  readonly services: ServiceMap.ServiceMap<any>
}): Handlers<any, any> => Object.assign(Object.create(handlersProto), options)

/**
 * @since 4.0.0
 * @category handlers
 */
export const group = <Events extends Event.Any, Return>(
  group: EventGroup.EventGroup<Events>,
  f: (handlers: Handlers<never, Events>) => Handlers.ValidateReturn<Return>
): Layer.Layer<Event.ToService<Events>, Handlers.Error<Return>, Exclude<Handlers.Services<Return>, Scope.Scope>> =>
  Layer.effectServices(
    Effect.gen(function*() {
      const services = yield* Effect.services<Handlers.Services<Return>>()
      const result = f(makeHandlers({
        group: group as EventGroup.AnyWithProps,
        handlers: {},
        services
      }) as unknown as Handlers<never, Events>)
      const handlers = Effect.isEffect(result)
        ? (yield* (result as unknown as Effect.Effect<Handlers<any>>))
        : (result as unknown as Handlers<any>)
      const serviceMap = new Map<string, Handlers.Item<any>>()
      for (const tag in handlers.handlers) {
        const handler = handlers.handlers[tag]
        serviceMap.set(handler.event.key, handlers.handlers[tag])
      }
      return ServiceMap.makeUnsafe(serviceMap)
    })
  )

/**
 * @since 4.0.0
 * @category compaction
 */
export const groupCompaction = <Events extends Event.Any, R>(
  group: EventGroup.EventGroup<Events>,
  effect: (options: {
    readonly primaryKey: string
    readonly entries: ReadonlyArray<Entry>
    readonly events: ReadonlyArray<Event.TaggedPayload<Events>>
    readonly write: <Tag extends Event.Tag<Events>>(
      tag: Tag,
      payload: Event.PayloadWithTag<Events, Tag>
    ) => Effect.Effect<void, never, Event.PayloadSchemaWithTag<Events, Tag>["EncodingServices"]>
  }) => Effect.Effect<void, never, R>
): Layer.Layer<never, never, Identity | EventJournal | R | Event.PayloadSchema<Events>["DecodingServices"]> =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const log = yield* EventLog
      const services = yield* Effect.services<R | Event.PayloadSchema<Events>["DecodingServices"]>()

      yield* log.registerCompaction({
        events: Object.keys(group.events),
        effect: Effect.fnUntraced(function*({ entries, write }): Effect.fn.Return<void> {
          const isEventTag = (tag: string): tag is Event.Tag<Events> => tag in group.events
          const decodePayload = <Tag extends Event.Tag<Events>>(tag: Tag, payload: Uint8Array) =>
            Schema.decodeUnknownEffect(group.events[tag].payloadMsgPack)(payload).pipe(
              Effect.updateServices((input) => ServiceMap.merge(services, input)),
              Effect.orDie
            ) as unknown as Effect.Effect<Event.PayloadWithTag<Events, Tag>>
          const writePayload = Effect.fnUntraced(function*<Tag extends Event.Tag<Events>>(
            timestamp: number,
            tag: Tag,
            payload: Event.PayloadWithTag<Events, Tag>
          ): Effect.fn.Return<void, never, Event.PayloadSchemaWithTag<Events, Tag>["EncodingServices"]> {
            const event = group.events[tag]
            const entry = new Entry({
              id: makeEntryIdUnsafe({ msecs: timestamp }),
              event: tag,
              payload: yield* Schema.encodeUnknownEffect(event.payloadMsgPack)(payload).pipe(
                Effect.orDie
              ) as any,
              primaryKey: event.primaryKey(payload)
            }, { disableChecks: true })
            yield* write(entry)
          })

          const byPrimaryKey = new Map<
            string,
            {
              readonly entries: Array<Entry>
              readonly taggedPayloads: Array<Event.TaggedPayload<Events>>
            }
          >()
          for (const entry of entries) {
            if (!isEventTag(entry.event)) {
              continue
            }
            const payload = yield* decodePayload(entry.event, entry.payload)
            const record = byPrimaryKey.get(entry.primaryKey)
            const taggedPayload = { _tag: entry.event, payload } as unknown as Event.TaggedPayload<Events>
            if (record) {
              record.entries.push(entry)
              record.taggedPayloads.push(taggedPayload)
            } else {
              byPrimaryKey.set(entry.primaryKey, {
                entries: [entry],
                taggedPayloads: [taggedPayload]
              })
            }
          }

          for (const [primaryKey, { entries, taggedPayloads }] of byPrimaryKey) {
            yield* Effect.orDie(
              effect({
                primaryKey,
                entries,
                events: taggedPayloads,
                write(tag, payload) {
                  return Effect.orDie(writePayload(entries[0].createdAtMillis, tag, payload))
                }
              }).pipe(
                Effect.updateServices((input) => ServiceMap.merge(services, input))
              )
            ) as any
          }
        })
      })
    })
  ).pipe(
    Layer.provide(layerEventLog)
  )

/**
 * @since 4.0.0
 * @category reactivity
 */
export const groupReactivity = <Events extends Event.Any>(
  group: EventGroup.EventGroup<Events>,
  keys:
    | { readonly [Tag in Event.Tag<Events>]?: ReadonlyArray<string> }
    | ReadonlyArray<string>
): Layer.Layer<never, never, Identity | EventJournal> =>
  Effect.gen(function*() {
    const log = yield* EventLog
    if (!Array.isArray(keys)) {
      yield* log.registerReactivity(keys as Record.ReadonlyRecord<string, ReadonlyArray<string>>)
      return
    }
    const obj: Record<string, ReadonlyArray<string>> = {}
    for (const tag in group.events) {
      obj[tag] = keys
    }
    yield* log.registerReactivity(obj)
  }).pipe(
    Layer.effectDiscard,
    Layer.provide(layerEventLog)
  )

/**
 * @since 4.0.0
 * @category tags
 */
export class EventLog extends ServiceMap.Service<EventLog, {
  readonly write: <Groups extends EventGroup.Any, Tag extends Event.Tag<EventGroup.Events<Groups>>>(options: {
    readonly schema: EventLogSchema<Groups>
    readonly event: Tag
    readonly payload: Event.PayloadWithTag<EventGroup.Events<Groups>, Tag>
  }) => Effect.Effect<
    Event.SuccessWithTag<EventGroup.Events<Groups>, Tag>,
    Event.ErrorWithTag<EventGroup.Events<Groups>, Tag> | EventJournalError
  >
  readonly registerRemote: (remote: EventLogRemote["Service"]) => Effect.Effect<void, never, Scope.Scope>
  readonly registerCompaction: (options: {
    readonly events: ReadonlyArray<string>
    readonly effect: (options: {
      readonly entries: ReadonlyArray<Entry>
      readonly write: (entry: Entry) => Effect.Effect<void>
    }) => Effect.Effect<void>
  }) => Effect.Effect<void, never, Scope.Scope>
  readonly registerReactivity: (keys: Record<string, ReadonlyArray<string>>) => Effect.Effect<void, never, Scope.Scope>
  readonly entries: Effect.Effect<ReadonlyArray<Entry>, EventJournalError>
  readonly destroy: Effect.Effect<void, EventJournalError>
}>()("effect/eventlog/EventLog") {}

const make = Effect.gen(function*() {
  const identity = yield* Identity
  const journal = yield* EventJournal
  const services = yield* Effect.services<never>()

  const remotes = yield* FiberMap.make<RemoteId>()
  const compactors = new Map<string, {
    readonly events: ReadonlySet<string>
    readonly effect: (options: {
      readonly entries: ReadonlyArray<Entry>
      readonly write: (entry: Entry) => Effect.Effect<void>
    }) => Effect.Effect<void>
  }>()
  const journalSemaphore = yield* Semaphore.make(1)

  const reactivity = yield* Reactivity
  const reactivityKeys: Record<string, ReadonlyArray<string>> = {}

  const runRemote = Effect.fnUntraced(
    function*(remote: EventLogRemote["Service"]) {
      const startSequence = yield* journal.nextRemoteSequence(remote.id)
      const changes = yield* remote.changes(identity, startSequence)

      yield* Queue.takeAll(changes).pipe(
        Effect.flatMap((entries) =>
          journal.writeFromRemote({
            remoteId: remote.id,
            entries: entries.flat(),
            compact: compactors.size > 0
              ? Effect.fnUntraced(function*(remoteEntries) {
                const brackets: Array<[Array<Entry>, Array<RemoteEntry>]> = []
                let uncompacted: Array<Entry> = []
                let uncompactedRemote: Array<RemoteEntry> = []
                let index = 0
                while (index < remoteEntries.length) {
                  const remoteEntry = remoteEntries[index]
                  const compactor = compactors.get(remoteEntry.entry.event)
                  if (!compactor) {
                    uncompacted.push(remoteEntry.entry)
                    uncompactedRemote.push(remoteEntry)
                    index++
                    continue
                  }
                  if (uncompacted.length > 0) {
                    brackets.push([uncompacted, uncompactedRemote])
                    uncompacted = []
                    uncompactedRemote = []
                  }
                  const entries = [remoteEntry.entry]
                  const remoteGroup = [remoteEntry]
                  const compacted: Array<Entry> = []
                  index++
                  while (index < remoteEntries.length) {
                    const nextRemoteEntry = remoteEntries[index]
                    if (!compactor.events.has(nextRemoteEntry.entry.event)) {
                      break
                    }
                    entries.push(nextRemoteEntry.entry)
                    remoteGroup.push(nextRemoteEntry)
                    index++
                  }
                  yield* compactor.effect({
                    entries,
                    write(entry) {
                      return Effect.sync(() => {
                        compacted.push(entry)
                      })
                    }
                  }).pipe(Effect.orDie)
                  brackets.push([compacted, remoteGroup])
                }
                if (uncompacted.length > 0) {
                  brackets.push([uncompacted, uncompactedRemote])
                }
                return brackets
              })
              : undefined,
            effect: Effect.fnUntraced(
              function*({ conflicts, entry }): Effect.fn.Return<void, Schema.SchemaError> {
                const handler = services.mapUnsafe.get(Event.serviceKey(entry.event)) as Handlers.Item<any> | undefined
                if (!handler) {
                  return yield* Effect.logDebug(`Event handler not found for: "${entry.event}"`)
                }
                const decodePayload = Schema.decodeUnknownEffect(handler.event.payloadMsgPack)
                const decodedConflicts: Array<{ entry: Entry; payload: unknown }> = new Array(conflicts.length)
                for (let i = 0; i < conflicts.length; i++) {
                  decodedConflicts[i] = {
                    entry: conflicts[i],
                    payload: yield* decodePayload(conflicts[i].payload).pipe(
                      Effect.updateServices((input) => ServiceMap.merge(handler.services, input))
                    ) as any
                  }
                }
                yield* decodePayload(entry.payload).pipe(
                  Effect.flatMap((payload) =>
                    handler.handler({
                      payload,
                      entry,
                      conflicts: decodedConflicts
                    })
                  ),
                  Effect.updateServices((input) => ServiceMap.merge(handler.services, input)),
                  Effect.asVoid
                ) as any
                if (reactivityKeys[entry.event]) {
                  for (const key of reactivityKeys[entry.event]) {
                    yield* Effect.sync(() =>
                      reactivity.invalidateUnsafe({
                        [key]: [entry.primaryKey]
                      })
                    )
                  }
                }
              },
              Effect.catchCause(Effect.logError),
              (effect, { entry }) =>
                Effect.annotateLogs(effect, {
                  service: "EventLog",
                  effect: "writeFromRemote",
                  entryId: entry.idString
                })
            )
          }).pipe(journalSemaphore.withPermits(1))
        ),
        Effect.catchCause(Effect.logError),
        Effect.forever,
        Effect.annotateLogs({
          service: "EventLog",
          effect: "runRemote consume"
        }),
        Effect.forkScoped
      )

      const write = journal.withRemoteUncommited(remote.id, (entries) => remote.write(identity, entries))
      yield* Effect.addFinalizer(() => Effect.ignore(write))
      yield* write
      const changesSub = yield* journal.changes
      return yield* PubSub.takeAll(changesSub).pipe(
        Effect.andThen(Effect.sleep("500 millis")),
        Effect.andThen(write),
        Effect.catchCause(Effect.logError),
        Effect.forever
      )
    },
    Effect.scoped,
    Effect.provideService(Identity, identity),
    Effect.interruptible
  )

  const writeHandler = Effect.fnUntraced(function*(handler: Handlers.Item<any>, options: {
    readonly schema: EventLogSchema<any>
    readonly event: string
    readonly payload: unknown
  }) {
    const payload = yield* Schema.encodeUnknownEffect(handler.event.payloadMsgPack)(options.payload).pipe(
      Effect.orDie
    )
    return yield* journalSemaphore.withPermits(1)(journal.write({
      event: options.event,
      primaryKey: handler.event.primaryKey(options.payload as never),
      payload,
      effect: (entry) =>
        handler.handler({
          payload: options.payload,
          entry,
          conflicts: []
        }).pipe(
          Effect.updateServices((input) => ServiceMap.merge(handler.services, input)),
          Effect.tap(() =>
            Effect.sync(() => {
              if (reactivityKeys[entry.event]) {
                for (const key of reactivityKeys[entry.event]) {
                  reactivity.invalidateUnsafe({
                    [key]: [entry.primaryKey]
                  })
                }
              }
            })
          )
        )
    }))
  })

  const eventLogWrite = (options: {
    readonly schema: EventLogSchema<any>
    readonly event: string
    readonly payload: unknown
  }) => {
    const handler = services.mapUnsafe.get(Event.serviceKey(options.event)) as Handlers.Item<any> | undefined
    if (handler === undefined) {
      return Effect.die(`Event handler not found for: "${options.event}"`)
    }
    return writeHandler(handler, options)
  }

  return EventLog.of({
    write: eventLogWrite as EventLog["Service"]["write"],
    entries: journal.entries,
    registerRemote: (remote) =>
      Effect.acquireRelease(
        FiberMap.run(remotes, remote.id, runRemote(remote)),
        () => FiberMap.remove(remotes, remote.id)
      ).pipe(Effect.asVoid),
    registerCompaction: (options) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const events = new Set(options.events)
          const compactor = {
            events,
            effect: options.effect
          }
          for (const event of options.events) {
            compactors.set(event, compactor)
          }
        }),
        () =>
          Effect.sync(() => {
            for (const event of options.events) {
              compactors.delete(event)
            }
          })
      ),
    registerReactivity: (keys) =>
      Effect.sync(() => {
        Object.assign(reactivityKeys, keys)
      }),
    destroy: journal.destroy
  })
})

/**
 * @since 4.0.0
 * @category layers
 */
export const layerEventLog: Layer.Layer<EventLog, never, EventJournal | Identity> = Layer.effect(EventLog, make).pipe(
  Layer.provide(ReactivityLayer.layer)
)

/**
 * @since 4.0.0
 * @category layers
 */
export const layer = <Groups extends EventGroup.Any>(_schema: EventLogSchema<Groups>): Layer.Layer<
  EventLog,
  never,
  EventGroup.ToService<Groups> | EventJournal | Identity
> => layerEventLog as Layer.Layer<EventLog, never, EventGroup.ToService<Groups> | EventJournal | Identity>

/**
 * @since 4.0.0
 * @category client
 */
export const makeClient = <Groups extends EventGroup.Any>(
  schema: EventLogSchema<Groups>
): Effect.Effect<
  (<Tag extends Event.Tag<EventGroup.Events<Groups>>>(
    event: Tag,
    payload: Event.PayloadWithTag<EventGroup.Events<Groups>, Tag>
  ) => Effect.Effect<
    Event.SuccessWithTag<EventGroup.Events<Groups>, Tag>,
    Event.ErrorWithTag<EventGroup.Events<Groups>, Tag> | EventJournalError
  >),
  never,
  EventLog
> =>
  Effect.gen(function*() {
    const log = yield* EventLog

    return <Tag extends Event.Tag<EventGroup.Events<Groups>>>(
      event: Tag,
      payload: Event.PayloadWithTag<EventGroup.Events<Groups>, Tag>
    ): Effect.Effect<
      Event.SuccessWithTag<EventGroup.Events<Groups>, Tag>,
      Event.ErrorWithTag<EventGroup.Events<Groups>, Tag> | EventJournalError
    > => log.write({ schema, event, payload })
  })
