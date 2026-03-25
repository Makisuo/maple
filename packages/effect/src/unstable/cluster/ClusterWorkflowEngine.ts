/**
 * @since 4.0.0
 */
import * as DateTime from "../../DateTime.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import * as Latch from "../../Latch.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as PrimaryKey from "../../PrimaryKey.ts"
import * as RcMap from "../../RcMap.ts"
import type * as Record from "../../Record.ts"
import * as Schedule from "../../Schedule.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Rpc from "../rpc/Rpc.ts"
import { ClientAbort } from "../rpc/RpcSchema.ts"
import * as Activity from "../workflow/Activity.ts"
import * as DurableClock from "../workflow/DurableClock.ts"
import * as DurableDeferred from "../workflow/DurableDeferred.ts"
import * as Workflow from "../workflow/Workflow.ts"
import * as WorkflowEngine from "../workflow/WorkflowEngine.ts"
import * as ClusterSchema from "./ClusterSchema.ts"
import * as DeliverAt from "./DeliverAt.ts"
import * as Entity from "./Entity.ts"
import * as EntityAddress from "./EntityAddress.ts"
import * as EntityId from "./EntityId.ts"
import * as EntityType from "./EntityType.ts"
import { MessageStorage } from "./MessageStorage.ts"
import type { WithExitEncoded } from "./Reply.ts"
import * as Reply from "./Reply.ts"
import * as Sharding from "./Sharding.ts"
import * as Snowflake from "./Snowflake.ts"

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make = Effect.gen(function*() {
  const sharding = yield* Sharding.Sharding
  const storage = yield* MessageStorage

  const workflows = new Map<string, Workflow.Any>()
  const entities = new Map<
    string,
    Entity.Entity<
      string,
      | Rpc.Rpc<
        "run",
        Schema.Struct<
          Record<
            typeof payloadParentKey,
            Schema.optional<
              Schema.Struct<{
                workflowName: typeof Schema.String
                executionId: typeof Schema.String
              }>
            >
          >
        >,
        Schema.declare<Workflow.Result<any, any>>
      >
      | Rpc.Rpc<"deferred", Schema.Struct<{ name: typeof Schema.String; exit: typeof ExitUnknown }>, typeof ExitUnknown>
      | Rpc.Rpc<
        "activity",
        Schema.Struct<{ name: typeof Schema.String; attempt: typeof Schema.Number }>,
        Schema.declare<Workflow.Result<any, any>>
      >
      | Rpc.Rpc<"resume", Schema.Struct<{}>>
    >
  >()
  const partialEntities = new Map<
    string,
    Entity.Entity<
      string,
      | Rpc.Rpc<"deferred", Schema.Struct<{ name: typeof Schema.String; exit: typeof ExitUnknown }>, typeof ExitUnknown>
      | Rpc.Rpc<
        "activity",
        Schema.Struct<{ name: typeof Schema.String; attempt: typeof Schema.Number }>,
        Schema.declare<Workflow.Result<any, any>>
      >
      | Rpc.Rpc<"resume">
    >
  >()
  const ensureEntity = (workflow: Workflow.Any) => {
    let entity = entities.get(workflow.name)
    if (!entity) {
      entity = makeWorkflowEntity(workflow) as any
      workflows.set(workflow.name, workflow)
      entities.set(workflow.name, entity as any)
    }
    return entity!
  }
  const ensurePartialEntity = (workflowName: string) => {
    let entity = partialEntities.get(workflowName)
    if (!entity) {
      entity = makePartialWorkflowEntity(workflowName) as any
      partialEntities.set(workflowName, entity as any)
    }
    return entity!
  }

  const activities = new Map<string, {
    readonly activity: Activity.Any
    readonly services: ServiceMap.ServiceMap<any>
  }>()
  const interruptedActivities = new Set<string>()
  const activityLatches = new Map<string, Latch.Latch>()
  const clients = yield* RcMap.make({
    lookup: Effect.fnUntraced(function*(workflowName: string) {
      const entity = entities.get(workflowName)
      if (!entity) {
        return yield* Effect.die(`Workflow ${workflowName} not registered`)
      }
      return yield* entity.client
    }),
    idleTimeToLive: "5 minutes"
  })
  const clientsPartial = yield* RcMap.make({
    lookup: Effect.fnUntraced(function*(workflowName: string) {
      const entity = entities.get(workflowName) ?? ensurePartialEntity(workflowName)
      return yield* entity.client
    }),
    idleTimeToLive: "5 minutes"
  })
  const clockClient = yield* ClockEntity.client

  const requestIdFor = Effect.fnUntraced(function*(options: {
    readonly workflow: Workflow.Any
    readonly entityType: string
    readonly executionId: string
    readonly tag: string
    readonly id: string
  }) {
    const shardGroup = ServiceMap.get(options.workflow.annotations, ClusterSchema.ShardGroup)(
      options.executionId as EntityId.EntityId
    )
    const entityId = EntityId.make(options.executionId)
    const address = EntityAddress.make({
      entityType: EntityType.make(options.entityType),
      entityId,
      shardId: sharding.getShardId(entityId, shardGroup)
    })
    return yield* storage.requestIdForPrimaryKey({ address, tag: options.tag, id: options.id })
  })

  const replyForRequestId = Effect.fnUntraced(function*(requestId: Snowflake.Snowflake) {
    const replies = yield* storage.repliesForUnfiltered([requestId])
    const last = replies[replies.length - 1]
    if (last && last._tag === "WithExit") {
      return Option.some(last as WithExitEncoded<Workflow.ResultEncoded<any, any>>)
    }
    return Option.none<WithExitEncoded<Workflow.ResultEncoded<any, any>>>()
  })

  const requestReply = Effect.fnUntraced(function*(options: {
    readonly workflow: Workflow.Any
    readonly entityType: string
    readonly executionId: string
    readonly tag: string
    readonly id: string
  }) {
    const requestId = yield* requestIdFor(options)
    if (Option.isNone(requestId)) {
      return Option.none<WithExitEncoded<Workflow.ResultEncoded<any, any>>>()
    }
    return yield* replyForRequestId(requestId.value)
  })

  const resetActivityAttempt = Effect.fnUntraced(
    function*(options: {
      readonly workflow: Workflow.Any
      readonly executionId: string
      readonly activity: Activity.Any
      readonly attempt: number
    }) {
      const requestId = yield* requestIdFor({
        workflow: options.workflow,
        entityType: `Workflow/${options.workflow.name}`,
        executionId: options.executionId,
        tag: "activity",
        id: activityPrimaryKey(options.activity.name, options.attempt)
      })
      if (Option.isNone(requestId)) return
      yield* sharding.reset(requestId.value)
    },
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential(250)
    }),
    Effect.orDie
  )

  const clearClock = Effect.fnUntraced(function*(options: {
    readonly workflow: Workflow.Any
    readonly executionId: string
  }) {
    const shardGroup = ServiceMap.get(options.workflow.annotations, ClusterSchema.ShardGroup)(
      options.executionId as EntityId.EntityId
    )
    const entityId = EntityId.make(options.executionId)
    const shardId = sharding.getShardId(entityId, shardGroup)
    const clockAddress = EntityAddress.make({
      entityType: ClockEntity.type,
      entityId,
      shardId
    })
    yield* storage.clearAddress(clockAddress)
  })

  const resume = Effect.fnUntraced(function*(workflow: Workflow.Any, executionId: string) {
    const maybeReply = yield* requestReply({
      workflow,
      entityType: `Workflow/${workflow.name}`,
      executionId,
      tag: "run",
      id: ""
    })

    const maybeSuspended = Option.filter(
      maybeReply,
      (reply) => reply.exit._tag === "Success" && reply.exit.value._tag === "Suspended"
    )

    if (Option.isNone(maybeSuspended)) return
    yield* sharding.reset(Snowflake.Snowflake(maybeSuspended.value.requestId))
    yield* sharding.pollStorage
  })

  const sendResumeParent = Effect.fnUntraced(function*(options: {
    readonly workflowName: string
    readonly executionId: string
  }) {
    const requestId = yield* requestIdFor({
      workflow: workflows.get(options.workflowName)!,
      entityType: `Workflow/${options.workflowName}`,
      executionId: options.executionId,
      tag: "resume",
      id: ""
    })
    if (Option.isNone(requestId)) {
      const client = (yield* RcMap.get(clientsPartial, options.workflowName))(options.executionId)
      return yield* client.resume({} as any, { discard: true })
    }
    const reply = yield* replyForRequestId(requestId.value)
    if (Option.isNone(reply)) return
    yield* sharding.reset(requestId.value)
  }, Effect.scoped)

  const engine = WorkflowEngine.makeUnsafe({
    register: (workflow, execute) =>
      Effect.suspend(() =>
        sharding.registerEntity(
          ensureEntity(workflow),
          Effect.gen(function*() {
            const address = yield* Entity.CurrentAddress
            const executionId = address.entityId
            return {
              run: (request: Entity.Request<any>) => {
                const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId)
                const payload = request.payload as any
                let parent: { workflowName: string; executionId: string } | undefined
                if (payload[payloadParentKey]) {
                  parent = payload[payloadParentKey]
                }
                return execute(workflow.payloadSchema.makeUnsafe(payload) as object, executionId).pipe(
                  Effect.onExit((exit) => {
                    const suspendOnFailure = ServiceMap.get(workflow.annotations, Workflow.SuspendOnFailure)
                    if (!instance.suspended && !(suspendOnFailure && exit._tag === "Failure")) {
                      return parent ? ensureSuccess(sendResumeParent(parent)) : Effect.void
                    }
                    return engine.deferredResult(InterruptSignal).pipe(
                      Effect.flatMap((maybeExit) => {
                        if (Option.isNone(maybeExit)) {
                          return Effect.void
                        }
                        instance.suspended = false
                        instance.interrupted = true
                        return Effect.andThen(
                          Effect.ignore(clearClock({ workflow, executionId })),
                          Effect.withFiber<void>((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
                        )
                      }),
                      Effect.orDie
                    )
                  }),
                  Workflow.intoResult,
                  Effect.provideService(WorkflowEngine.WorkflowInstance, instance)
                ) as any
              },

              activity(request: Entity.Request<any>) {
                const payload = request.payload as { name: string; attempt: number }
                const activityId = `${executionId}/${payload.name}`
                const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId)
                interruptedActivities.delete(activityId)
                return Effect.gen(function*() {
                  let entry = activities.get(activityId)
                  while (!entry) {
                    const latch = Latch.makeUnsafe()
                    activityLatches.set(activityId, latch)
                    yield* latch.await
                    entry = activities.get(activityId)
                  }
                  const contextMap = new Map(entry.services.mapUnsafe)
                  contextMap.set(Activity.CurrentAttempt.key, payload.attempt)
                  contextMap.set(WorkflowEngine.WorkflowInstance.key, instance)
                  return yield* entry.activity.executeEncoded.pipe(
                    Effect.provideServices(ServiceMap.makeUnsafe(contextMap))
                  )
                }).pipe(
                  Workflow.intoResult,
                  Effect.catchCause((cause) => {
                    // we only want to store interrupts as suspends when the
                    // client requested it
                    const suspend = cause.reasons.some((f) =>
                      f._tag === "Interrupt" && f.annotations.has(ClientAbort.key)
                    )
                    if (suspend) {
                      interruptedActivities.add(activityId)
                      return Effect.succeed(new Workflow.Suspended({}))
                    }
                    return Effect.failCause(cause)
                  }),
                  Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
                  Effect.provideService(Activity.CurrentAttempt, payload.attempt),
                  Effect.ensuring(Effect.sync(() => {
                    activities.delete(activityId)
                  })),
                  Rpc.wrap({ fork: true, uninterruptible: true })
                )
              },

              deferred: Effect.fnUntraced(function*(request: Entity.Request<any>) {
                const payload = request.payload as any
                yield* ensureSuccess(resume(workflow, executionId))
                return payload.exit
              }),

              resume: () => ensureSuccess(resume(workflow, executionId))
            }
          })
        ) as Effect.Effect<void, never, Scope.Scope>
      ),

    execute: (workflow, { discard, executionId, parent, payload }) => {
      ensureEntity(workflow)
      return RcMap.get(clients, workflow.name).pipe(
        Effect.flatMap((make) =>
          make(executionId).run(
            parent ?
              {
                ...payload,
                [payloadParentKey]: { workflowName: parent.workflow.name, executionId: parent.executionId }
              } :
              payload,
            { discard }
          )
        ),
        Effect.orDie,
        Effect.scoped
      )
    },

    poll: Effect.fnUntraced(function*(workflow, executionId) {
      const entity = ensureEntity(workflow)
      const exitSchema = Schema.toCodecJson(Rpc.exitSchema(entity.protocol.requests.get("run")!))
      const reply = yield* requestReply({
        workflow,
        entityType: `Workflow/${workflow.name}`,
        executionId,
        tag: "run",
        id: ""
      })
      if (Option.isNone(reply)) return Option.none()
      const exit = yield* (Schema.decodeUnknownEffect(exitSchema)(reply.value.exit) as Effect.Effect<
        Exit.Exit<any, any>,
        Schema.SchemaError
      >)
      return Option.some(yield* exit)
    }, Effect.orDie),

    interrupt: Effect.fnUntraced(
      function*(workflow, executionId) {
        ensureEntity(workflow)
        const reply = yield* requestReply({
          workflow,
          entityType: `Workflow/${workflow.name}`,
          executionId,
          tag: "run",
          id: ""
        })

        const nonSuspendedReply = Option.filter(
          reply,
          (reply) => reply.exit._tag !== "Success" || reply.exit.value._tag !== "Suspended"
        )
        if (Option.isSome(nonSuspendedReply)) {
          return
        }

        yield* engine.deferredDone(InterruptSignal, {
          workflowName: workflow.name,
          executionId,
          deferredName: InterruptSignal.name,
          exit: Exit.void
        })
      },
      Effect.retry({
        while: (e) => e._tag === "PersistenceError",
        times: 3,
        schedule: Schedule.exponential(250)
      }),
      Effect.orDie
    ),

    resume: (workflow, executionId) => ensureSuccess(resume(workflow, executionId)),

    activityExecute: Effect.fnUntraced(
      function*(activity, attempt) {
        const services = yield* Effect.services<WorkflowEngine.WorkflowInstance>()
        const instance = ServiceMap.get(services, WorkflowEngine.WorkflowInstance)
        yield* Effect.annotateCurrentSpan("executionId", instance.executionId)
        const activityId = `${instance.executionId}/${activity.name}`
        const client = (yield* RcMap.get(clientsPartial, instance.workflow.name))(instance.executionId)
        while (true) {
          if (!activities.has(activityId)) {
            activities.set(activityId, { activity, services })
            const latch = activityLatches.get(activityId)
            if (latch) {
              yield* latch.release
              activityLatches.delete(activityId)
            }
          }
          const result = yield* Effect.orDie(client.activity({ name: activity.name, attempt }))
          // If the activity has suspended and did not execute, we need to resume
          // it by resetting the attempt and re-executing.
          if (result._tag === "Suspended" && (activities.has(activityId) || interruptedActivities.has(activityId))) {
            yield* resetActivityAttempt({
              workflow: instance.workflow,
              executionId: instance.executionId,
              activity,
              attempt
            })
            continue
          }
          activities.delete(activityId)
          return result
        }
      },
      Effect.scoped
    ),

    deferredResult: (deferred) =>
      WorkflowEngine.WorkflowInstance.asEffect().pipe(
        Effect.flatMap((instance) =>
          requestReply({
            workflow: instance.workflow,
            entityType: `Workflow/${instance.workflow.name}`,
            executionId: instance.executionId,
            tag: "deferred",
            id: deferred.name
          })
        ),
        Effect.map((reply) => {
          if (Option.isNone(reply)) {
            return Option.none<Exit.Exit<unknown, unknown>>()
          }
          const decoded = decodeDeferredWithExit(reply.value as any)
          return Option.some(
            decoded.exit._tag === "Success"
              ? decoded.exit.value
              : decoded.exit
          )
        }),
        Effect.retry({
          while: (e) => e._tag === "PersistenceError",
          times: 3,
          schedule: Schedule.exponential(250)
        }),
        Effect.orDie
      ),

    deferredDone: Effect.fnUntraced(
      function*({ deferredName, executionId, exit, workflowName }) {
        const client = yield* RcMap.get(clientsPartial, workflowName)
        return yield* Effect.orDie(
          client(executionId).deferred({
            name: deferredName,
            exit
          }, { discard: true })
        )
      },
      Effect.scoped
    ),

    scheduleClock(workflow, options) {
      const client = clockClient(options.executionId)
      return DateTime.now.pipe(
        Effect.flatMap((now) =>
          client.run({
            name: options.clock.name,
            workflowName: workflow.name,
            wakeUp: DateTime.addDuration(now, options.clock.duration)
          }, { discard: true })
        ),
        Effect.orDie
      )
    }
  })

  return engine
})

const retryPolicy = Schedule.exponential(200, 1.5).pipe(
  Schedule.either(Schedule.spaced("1 minute"))
)

const ensureSuccess = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.sandbox,
    Effect.retry(retryPolicy),
    Effect.orDie
  )

const AnyOrVoid = Schema.Union([Schema.Undefined, Schema.Any])
const ExitUnknown = Schema.Exit(AnyOrVoid, AnyOrVoid, Schema.Any)

const ActivityRpc = Rpc.make("activity", {
  payload: {
    name: Schema.String,
    attempt: Schema.Number
  },
  primaryKey: ({ attempt, name }) => activityPrimaryKey(name, attempt),
  success: Workflow.Result({
    success: AnyOrVoid,
    error: AnyOrVoid
  })
})
  .annotate(ClusterSchema.Persisted, true)

const DeferredRpc = Rpc.make("deferred", {
  payload: {
    name: Schema.String,
    exit: ExitUnknown
  },
  primaryKey: ({ name }) => name,
  success: ExitUnknown
})
  .annotate(ClusterSchema.Persisted, true)
  .annotate(ClusterSchema.Uninterruptible, true)

const decodeDeferredWithExit = Schema.decodeSync(Schema.toCodecJson(Reply.WithExit.schema(DeferredRpc)))

const ResumeRpc = Rpc.make("resume", {
  payload: {},
  primaryKey: () => ""
})
  .annotate(ClusterSchema.Persisted, true)
  .annotate(ClusterSchema.Uninterruptible, "server")

const payloadParentKey = "~effect/cluster/ClusterWorkflowEngine/payloadParentKey"

const makeWorkflowEntity = (workflow: Workflow.Any) =>
  Entity.make(`Workflow/${workflow.name}`, [
    Rpc.make("run", {
      payload: {
        ...workflow.payloadSchema.fields,
        [payloadParentKey]: Schema.optional(Schema.Struct({
          workflowName: Schema.String,
          executionId: Schema.String
        }))
      },
      primaryKey: () => "",
      success: Workflow.Result({
        success: workflow.successSchema,
        error: workflow.errorSchema
      })
    })
      .annotate(ClusterSchema.Persisted, true)
      .annotate(ClusterSchema.Uninterruptible, true),

    DeferredRpc,
    ResumeRpc,
    ActivityRpc
  ]).annotateMerge(workflow.annotations)

const makePartialWorkflowEntity = (workflowName: string) =>
  Entity.make(`Workflow/${workflowName}`, [
    DeferredRpc,
    ResumeRpc,
    ActivityRpc
  ])

const activityPrimaryKey = (activity: string, attempt: number) => `${activity}/${attempt}`

class ClockPayload extends Schema.Class<ClockPayload>(`Workflow/DurableClock/Run`)({
  name: Schema.String,
  workflowName: Schema.String,
  wakeUp: Schema.DateTimeUtcFromMillis
}) {
  [PrimaryKey.symbol]() {
    return this.name
  }
  [DeliverAt.symbol]() {
    return this.wakeUp
  }
}

const ClockEntity = Entity.make("Workflow/-/DurableClock", [
  Rpc.make("run", { payload: ClockPayload })
    .annotate(ClusterSchema.Persisted, true)
    .annotate(ClusterSchema.Uninterruptible, true)
])

const ClockEntityLayer = ClockEntity.toLayer(Effect.gen(function*() {
  const engine = yield* WorkflowEngine.WorkflowEngine
  const address = yield* Entity.CurrentAddress
  const executionId = address.entityId
  return {
    run(request) {
      const deferred = DurableClock.make({ name: request.payload.name, duration: Duration.zero }).deferred
      return ensureSuccess(engine.deferredDone(deferred, {
        workflowName: request.payload.workflowName,
        executionId,
        deferredName: deferred.name,
        exit: Exit.void
      }))
    }
  }
}))

const InterruptSignal = DurableDeferred.make("Workflow/InterruptSignal")

/**
 * @since 4.0.0
 * @category Layers
 */
export const layer: Layer.Layer<
  WorkflowEngine.WorkflowEngine,
  never,
  Sharding.Sharding | MessageStorage
> = ClockEntityLayer.pipe(
  Layer.provideMerge(Layer.effect(WorkflowEngine.WorkflowEngine)(make))
)
