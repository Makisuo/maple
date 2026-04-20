/**
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import { hasProperty, isTagged } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import { EntityAddress } from "./EntityAddress.ts"
import { RunnerAddress } from "./RunnerAddress.ts"
import { SnowflakeFromString } from "./Snowflake.ts"

const TypeId = "~effect/cluster/ClusterError"

/**
 * Represents an error that occurs when a Runner receives a message for an entity
 * that it is not assigned to it.
 *
 * @since 4.0.0
 * @category errors
 */
export class EntityNotAssignedToRunner
  extends Schema.ErrorClass<EntityNotAssignedToRunner>(`${TypeId}/EntityNotAssignedToRunner`)({
    _tag: Schema.tag("EntityNotAssignedToRunner"),
    address: EntityAddress
  })
{
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is EntityNotAssignedToRunner {
    return hasProperty(u, TypeId) && isTagged(u, "EntityNotAssignedToRunner")
  }
}

/**
 * Represents an error that occurs when a message fails to be properly
 * deserialized by an entity.
 *
 * @since 4.0.0
 * @category errors
 */
export class MalformedMessage extends Schema.ErrorClass<MalformedMessage>(`${TypeId}/MalformedMessage`)({
  _tag: Schema.tag("MalformedMessage"),
  cause: Schema.Defect
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is MalformedMessage {
    return hasProperty(u, TypeId) && isTagged(u, "MalformedMessage")
  }

  /**
   * @since 4.0.0
   */
  static refail: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<
    A,
    MalformedMessage,
    R
  > = Effect.mapError((cause) => new MalformedMessage({ cause }))
}

/**
 * Represents an error that occurs when a message fails to be persisted into
 * cluster's mailbox storage.
 *
 * @since 4.0.0
 * @category errors
 */
export class PersistenceError extends Schema.ErrorClass<PersistenceError>(`${TypeId}/PersistenceError`)({
  _tag: Schema.tag("PersistenceError"),
  cause: Schema.Defect
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static refail<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersistenceError, R> {
    return Effect.catchCause(effect, (cause) => Effect.fail(new PersistenceError({ cause: Cause.squash(cause) })))
  }
}

/**
 * Represents an error that occurs when a Runner is not registered with the shard
 * manager.
 *
 * @since 4.0.0
 * @category errors
 */
export class RunnerNotRegistered extends Schema.ErrorClass<RunnerNotRegistered>(`${TypeId}/RunnerNotRegistered`)({
  _tag: Schema.tag("RunnerNotRegistered"),
  address: RunnerAddress
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents an error that occurs when a Runner is unresponsive.
 *
 * @since 4.0.0
 * @category errors
 */
export class RunnerUnavailable extends Schema.ErrorClass<RunnerUnavailable>(`${TypeId}/RunnerUnavailable`)({
  _tag: Schema.tag("RunnerUnavailable"),
  address: RunnerAddress
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is RunnerUnavailable {
    return hasProperty(u, TypeId) && isTagged(u, "RunnerUnavailable")
  }
}

/**
 * Represents an error that occurs when the entities mailbox is full.
 *
 * @since 4.0.0
 * @category errors
 */
export class MailboxFull extends Schema.ErrorClass<MailboxFull>(`${TypeId}/MailboxFull`)({
  _tag: Schema.tag("MailboxFull"),
  address: EntityAddress
}) {
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is MailboxFull {
    return hasProperty(u, TypeId) && isTagged(u, "MailboxFull")
  }
}

/**
 * Represents an error that occurs when the entity is already processing a
 * request.
 *
 * @since 4.0.0
 * @category errors
 */
export class AlreadyProcessingMessage
  extends Schema.ErrorClass<AlreadyProcessingMessage>(`${TypeId}/AlreadyProcessingMessage`)({
    _tag: Schema.tag("AlreadyProcessingMessage"),
    envelopeId: SnowflakeFromString,
    address: EntityAddress
  })
{
  /**
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * @since 4.0.0
   */
  static is(u: unknown): u is AlreadyProcessingMessage {
    return hasProperty(u, TypeId) && isTagged(u, "AlreadyProcessingMessage")
  }
}
