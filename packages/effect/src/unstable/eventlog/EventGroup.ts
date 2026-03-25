/**
 * @since 4.0.0
 */
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Record from "../../Record.ts"
import type * as Schema from "../../Schema.ts"
import * as Event from "./Event.ts"

/**
 * @since 4.0.0
 * @category type ids
 */
export type TypeId = "~effect/eventlog/EventGroup"

/**
 * @since 4.0.0
 * @category type ids
 */
export const TypeId: TypeId = "~effect/eventlog/EventGroup"

/**
 * @since 4.0.0
 * @category guards
 */
export const isEventGroup = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId)

/**
 * An `EventGroup` is a collection of `Event`s. You can use an `EventGroup` to
 * represent a portion of your domain.
 *
 * The events can be implemented later using the `EventLogBuilder.group` api.
 *
 * @since 4.0.0
 * @category models
 */
export interface EventGroup<
  out Events extends Event.Any = Event.Any
> extends Pipeable {
  readonly _?: symbol
  readonly __type?: Events | undefined
  readonly [TypeId]: TypeId
  readonly events: Record.ReadonlyRecord<string, Events>

  /**
   * Add an `Event` to the `EventGroup`.
   */
  add<
    Tag extends string,
    Payload extends Schema.Top = typeof Schema.Void,
    Success extends Schema.Top = typeof Schema.Void,
    Error extends Schema.Top = typeof Schema.Never
  >(options: {
    readonly tag: Tag
    readonly primaryKey: (payload: Schema.Schema.Type<Payload>) => string
    readonly payload?: Payload
    readonly success?: Success
    readonly error?: Error
  }): EventGroup<Events | Event.Event<Tag, Payload, Success, Error>>

  /**
   * Add an error schema to all the events in the `EventGroup`.
   */
  addError<Error extends Schema.Top>(error: Error): EventGroup<Event.AddError<Events, Error>>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any {
  readonly [TypeId]: TypeId
}

/**
 * @since 4.0.0
 * @category models
 */
export type AnyWithProps = EventGroup<Event.Any>

/**
 * @since 4.0.0
 * @category models
 */
export type ToService<A> = A extends EventGroup<infer _Events> ? Event.ToService<_Events>
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type Events<Group> = Group extends EventGroup<infer _Events> ? _Events
  : never

/**
 * @since 4.0.0
 * @category models
 */
export type ServicesClient<Group> = Event.ServicesClient<Events<Group>>

/**
 * @since 4.0.0
 * @category models
 */
export type ServicesServer<Group> = Event.ServicesServer<Events<Group>>

const makeProto = <
  Events extends Event.Any
>(options: {
  readonly events: Record.ReadonlyRecord<string, Events>
}): EventGroup<Events> => {
  const EventGroupClass = (_: never) => {}
  const group = Object.assign(EventGroupClass, {
    [TypeId]: TypeId,
    _: Symbol.for("~effect/eventlog/EventGroup"),
    __type: undefined,
    events: options.events,
    add<
      Tag extends string,
      Payload extends Schema.Top = typeof Schema.Void,
      Success extends Schema.Top = typeof Schema.Void,
      Error extends Schema.Top = typeof Schema.Never
    >(
      this: EventGroup<Events>,
      addOptions: {
        readonly tag: Tag
        readonly primaryKey: (payload: Schema.Schema.Type<Payload>) => string
        readonly payload?: Payload
        readonly success?: Success
        readonly error?: Error
      }
    ): EventGroup<Events | Event.Event<Tag, Payload, Success, Error>> {
      return makeProto({
        events: {
          ...this.events,
          [addOptions.tag]: Event.make(addOptions)
        }
      })
    },
    addError<Error extends Schema.Top>(
      this: EventGroup<Events>,
      error: Error
    ): EventGroup<Event.AddError<Events, Error>> {
      const events = Record.map<string, Events, Event.AddError<Events, Error>>(
        this.events,
        (event) => Event.addError(event, error)
      )
      return makeProto({ events })
    },
    pipe() {
      return pipeArguments(this, arguments)
    }
  })
  return group
}

/**
 * An `EventGroup` is a collection of `Event`s. You can use an `EventGroup` to
 * represent a portion of your domain.
 *
 * The events can be implemented later using the `EventLog.group` api.
 *
 * @since 4.0.0
 * @category constructors
 */
export const empty: EventGroup<never> = makeProto({ events: Record.empty() })
