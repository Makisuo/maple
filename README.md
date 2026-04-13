> **alchemy-effect** is in alpha and not ready for production use (expect breaking changes). Come hang in our [Discord](https://discord.gg/jwKw8dBJdN) to participate in the early stages of development.

# alchemy-effect

**Infrastructure-as-Effects** — unify your business logic and infrastructure into a single, type-safe [Effect](https://effect.website) program.

```bash
bun add alchemy-effect effect
```

## Define a Stack

A Stack is an Effect that declares Resources and returns outputs. Wire it up with `Stack.make` and provide cloud providers as Layers.

```typescript
import { AWS, Stack } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Effect.gen(function* () {
  const bucket = yield* AWS.S3.Bucket("MyBucket");

  return {
    bucketArn: bucket.bucketArn,
  };
}).pipe(Stack.make("MyStack"), Effect.provide(AWS.providers()()));
```

## Resources

Resources are declared inline as Effects. They produce typed Output Attributes that flow into other Resources.

```typescript
const bucket =
  yield *
  AWS.S3.Bucket("DataBucket", {
    forceDestroy: true,
  });

const queue =
  yield *
  AWS.SQS.Queue("JobsQueue", {
    fifo: true,
    visibilityTimeout: 60,
  });

const table =
  yield *
  AWS.DynamoDB.Table("UsersTable", {
    tableName: "users",
    partitionKey: { name: "pk", type: "S" },
    sortKey: { name: "sk", type: "S" },
  });
```

Output Attributes from one Resource can be passed as Input Properties to another — the engine resolves the dependency graph automatically.

## Lambda Functions

A Lambda Function is a special Resource whose Effect body defines the runtime behavior. The returned object configures the function's infrastructure.

```typescript
import * as Lambda from "alchemy-effect/AWS/Lambda";
import * as S3 from "alchemy-effect/AWS/S3";
import * as Http from "alchemy-effect/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Effect.gen(function* () {
  const bucket = yield* S3.Bucket("DataBucket");

  // bind S3 capabilities to this function's runtime
  const getObject = yield* S3.GetObject.bind(bucket);
  const putObject = yield* S3.PutObject.bind(bucket);

  // register a HTTP server for the Lambda runtime
  yield* Http.serve(myHttpApp);

  return {
    main: import.meta.filename,
    memory: 1024,
    url: true,
  } as const;
}).pipe(
  Effect.provide(
    Layer.mergeAll(Http.lambdaHttpServer, S3.GetObjectLive, S3.PutObjectLive),
  ),
  Lambda.Function("ApiFunction"),
);
```

## Services and Layers

Encapsulate Resources and capabilities into Effect Services for clean separation of concerns.

```typescript
import * as S3 from "alchemy-effect/AWS/S3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";

export class JobStorage extends Context.Service<
  JobStorage,
  {
    bucket: S3.Bucket;
    putJob(job: Job): Effect.Effect<Job>;
    getJob(jobId: string): Effect.Effect<Job | undefined>;
  }
>()("JobStorage") {}

export const jobStorage = Layer.effect(
  JobStorage,
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("JobsBucket");
    const getObject = yield* S3.GetObject.bind(bucket);
    const putObject = yield* S3.PutObject.bind(bucket);

    return JobStorage.of({
      bucket,
      putJob: (job) =>
        putObject({ Key: job.id, Body: JSON.stringify(job) }).pipe(
          Effect.map(() => job),
          Effect.orDie,
        ),
      getJob: (jobId) =>
        getObject({ Key: jobId }).pipe(
          Effect.map((item) => item.Body as any),
          Effect.orDie,
        ),
    });
  }),
);
```

Then provide it as a Layer to your Lambda Function:

```typescript
export default Effect.gen(function* () {
  const { bucket, getJob } = yield* JobStorage;
  // ...
  return { main: import.meta.filename, url: true } as const;
}).pipe(Effect.provide(jobStorage), Lambda.Function("JobFunction"));
```

## Event Sources

Subscribe to S3 notifications, SQS queues, and other event sources as Streams.

```typescript
import * as Stream from "effect/Stream";

yield *
  S3.notifications(bucket).subscribe((stream) =>
    stream.pipe(
      Stream.flatMap((item) => Stream.fromEffect(getJob(item.key))),
      Stream.tapSink(sink),
      Stream.runDrain,
    ),
  );
```

## HTTP APIs

Serve an [Effect HttpApi](https://effect.website) directly from a Lambda Function. Define endpoints, implement handlers, build a Layer, and convert it to an Effect that `Http.serve` can register.

```typescript
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

// 1. Define endpoints
const getJob = HttpApiEndpoint.get("getJob", "/", {
  success: Job,
  params: { jobId: JobId },
});

const createJob = HttpApiEndpoint.post("createJob", "/", {
  success: JobId,
  payload: Schema.Struct({ content: Schema.String }),
});

const JobApi = HttpApi.make("JobApi").add(
  HttpApiGroup.make("Jobs").add(getJob, createJob),
);

// 2. Implement handlers
const JobApiHandlers = HttpApiBuilder.group(JobApi, "Jobs", (handlers) =>
  handlers
    .handle(
      "getJob",
      Effect.fn(function* (req) {
        const storage = yield* JobStorage;
        return yield* storage.getJob(req.params.jobId);
      }),
    )
    .handle(
      "createJob",
      Effect.fn(function* (req) {
        const storage = yield* JobStorage;
        const job = yield* storage.putJob({
          id: "TODO",
          content: req.payload.content,
        });
        return job.id;
      }),
    ),
);

// 3. Build the API Layer and convert to an HttpEffect
const JobApiLive = HttpApiBuilder.layer(JobApi).pipe(
  Layer.provide(JobApiHandlers),
  Layer.provide(HttpServer.layerServices),
);

export const JobHttpEffect = HttpRouter.toHttpEffect(JobApiLive);
```

Then serve it inside your Lambda Function:

```typescript
yield * Http.serve(JobHttpEffect);
```

## RPC

Effect's RPC layer works the same way.

```typescript
import { Rpc, RpcGroup, RpcServer } from "effect/unstable/rpc";

const getJob = Rpc.make("getJob", {
  success: Job,
  error: JobNotFound,
  payload: { jobId: JobId },
});

export class JobRpcs extends RpcGroup.make(getJob, createJob) {}

export const JobRpcHttpEffect = RpcServer.toHttpEffect(JobRpcs).pipe(
  Effect.provide(JobRpcsLive),
);
```

## Removal Policy

Control what happens when a Resource is removed from your stack.

```typescript
import { RemovalPolicy } from "alchemy-effect";

const queue =
  yield * SQS.Queue("JobsQueue").pipe(RemovalPolicy.retain(stage === "prod"));
```

## AWS Configuration

Configure AWS credentials and region per stage using Effect Layers and Config.

```typescript
import { AWS, Stage } from "alchemy-effect";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const awsConfig = Layer.effect(
  AWS.StageConfig,
  Effect.gen(function* () {
    const stage = yield* Stage;

    if (stage === "prod") {
      return AWS.StageConfig.of({
        account: "123456789012",
        region: "us-west-2",
      });
    }

    return AWS.StageConfig.of({
      profile: "dev",
      account: "987654321098",
      region: yield* Config.string("AWS_REGION").pipe(
        Config.withDefault("us-west-2"),
      ),
    });
  }),
);

export default Effect.gen(function* () {
  // ...
}).pipe(
  Stack.make("MyStack"),
  Effect.provide(Layer.provide(AWS.providers()(), awsConfig)),
);
```

---

# Building Resources and Bindings

The sections below explain how to implement your own Resources, Resource Providers, and Bindings.

## Resource Contract

A Resource is defined by its Props (input) and Attributes (output). Use the `Resource` constructor to register the type.

```typescript
import { Resource } from "alchemy-effect/Resource";

export interface StreamProps {
  streamName?: string;
  streamMode?: "PROVISIONED" | "ON_DEMAND";
  shardCount?: number;
  retentionPeriodHours?: number;
  encryption?: boolean;
  kmsKeyId?: string;
  tags?: Record<string, string>;
}

export interface Stream extends Resource<
  "AWS.Kinesis.Stream",
  StreamProps,
  {
    streamName: string;
    streamArn: string;
    streamStatus: "CREATING" | "DELETING" | "ACTIVE" | "UPDATING";
  }
> {}

export const Stream = Resource<Stream>("AWS.Kinesis.Stream");
```

Users interact with the Resource as an Effect:

```typescript
const stream =
  yield *
  Stream("MyStream", {
    streamMode: "ON_DEMAND",
    retentionPeriodHours: 48,
  });

yield * Console.log(stream.streamArn); // typed Output attribute
```

## Resource Provider

A Resource Provider implements the lifecycle operations: `create`, `update`, `delete`, and optionally `diff` and `read`. It is registered via `Resource.provider.effect(...)`.

```typescript
export const StreamProvider = () =>
  Stream.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      return {
        // properties that are stable across updates (never change)
        stables: ["streamName", "streamArn"],

        // determine if a prop change requires replace vs update
        diff: Effect.fn(function* ({ id, news, olds }) {
          const oldName =
            olds.streamName ?? (yield* createPhysicalName({ id }));
          const newName =
            news.streamName ?? (yield* createPhysicalName({ id }));
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // returning void means "use default update logic"
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const streamName =
            news.streamName ??
            (yield* createPhysicalName({ id, maxLength: 128 }));

          yield* kinesis
            .createStream({
              StreamName: streamName,
              StreamModeDetails: { StreamMode: news.streamMode ?? "ON_DEMAND" },
              ShardCount:
                news.streamMode === "PROVISIONED" ? news.shardCount : undefined,
            })
            .pipe(Effect.catchTag("ResourceInUseException", () => Effect.void));

          yield* waitForStreamActive(streamName);

          return {
            streamName,
            streamArn: `arn:aws:kinesis:${region}:${accountId}:stream/${streamName}`,
            streamStatus: "ACTIVE" as const,
          };
        }),

        update: Effect.fn(function* ({ news, olds, output, session }) {
          // handle stream mode, shard count, retention, encryption changes
          // ...
          return output;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* kinesis
            .deleteStream({
              StreamName: output.streamName,
              EnforceConsumerDeletion: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
```

Key design principles:

- **Idempotent create** — handle the case where the resource already exists (e.g. catch `ResourceInUseException`).
- **Idempotent delete** — if the resource is already gone, don't error (e.g. catch `ResourceNotFoundException`).
- **Eventual consistency** — wait for the resource to reach a steady state before returning.
- **Tags** — use `createInternalTags` and `diffTags` from `alchemy-effect/Tags` to brand resources and diff tag changes.

## Binding.Service and Binding.Policy

Every capability (e.g. `S3.GetObject`, `Kinesis.PutRecord`) is split into two layers:

- **`Binding.Service`** — the runtime implementation (SDK call). Provided on the **Function** Effect so it is bundled into your Lambda/Worker.
- **`Binding.Policy`** — the deploy-time IAM policy attachment. Provided on the **Stack** via `AWS.providers()()` so it only runs during `plan`/`deploy`, never at runtime.

This separation means your Lambda bundle only includes the code it needs, while IAM policies are resolved at deploy time.

### Binding.Service

A `Binding.Service` wraps an SDK client and exposes a `.bind(resource)` method that returns a typed function for runtime use.

```typescript
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Binding from "alchemy-effect/Binding";

export class PutRecord extends Binding.Service<
  PutRecord,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordRequest,
    ) => Effect.Effect<Kinesis.PutRecordOutput, Kinesis.PutRecordError>
  >
>()("AWS.Kinesis.PutRecord") {}

export const PutRecordLive = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const Policy = yield* PutRecordPolicy;
    const putRecord = yield* Kinesis.putRecord;

    return Effect.fn(function* (stream: Stream) {
      const StreamName = yield* stream.streamName;
      yield* Policy(stream);
      return Effect.fn(function* (request: PutRecordRequest) {
        return yield* putRecord({ ...request, StreamName: yield* StreamName });
      });
    });
  }),
);
```

Provide the `*Live` layer on the **Function** — this is what gets bundled into the Lambda:

```typescript
export default Effect.gen(function* () {
  const stream = yield* Kinesis.Stream("Events", { streamMode: "ON_DEMAND" });
  const putRecord = yield* Kinesis.PutRecord.bind(stream);
  // use putRecord(...) at runtime
  return { main: import.meta.filename } as const;
}).pipe(Effect.provide(Kinesis.PutRecordLive), Lambda.Function("Producer"));
```

### Binding.Policy

A `Binding.Policy` runs only at deploy time to attach IAM policies (or Cloudflare bindings) to the Function's role. At runtime, `Binding.Policy` uses `Effect.serviceOption` so it gracefully becomes a no-op when the layer is not provided.

```typescript
import { isFunction } from "alchemy-effect/AWS/Lambda/Function";

export class PutRecordPolicy extends Binding.Policy<
  PutRecordPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.PutRecord") {}

export const PutRecordPolicyLive = PutRecordPolicy.layer.succeed(
  Effect.fn(function* (ctx, stream: Stream) {
    if (isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "PutRecord",
            Effect: "Allow",
            Action: ["kinesis:PutRecord"],
            Resource: [Output.interpolate`${stream.streamArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutRecordPolicy does not support runtime '${ctx.type}'`,
      );
    }
  }),
);
```

Policy layers are provided on the **Stack** through `AWS.providers()()`, not on the Function:

```typescript
// alchemy.run.ts — stack entrypoint
export default Effect.gen(function* () {
  const func = yield* MyFunction;
  return { url: func.functionUrl };
}).pipe(
  Stack.make("MyStack"),
  // AWS.providers()() includes all *PolicyLive layers (deploy-time only)
  Effect.provide(Layer.provide(AWS.providers()(), awsConfig)),
);
```

### The separation in practice

```
Stack (alchemy.run.ts)
├── AWS.providers()()
│   ├── Resource Providers (StreamProvider, BucketProvider, ...)
│   └── Binding Policies (PutRecordPolicyLive, GetObjectPolicyLive, ...)  ← deploy-time only
│
└── Lambda.Function("Producer")
    └── Effect.provide(...)
        ├── Kinesis.PutRecordLive  ← bundled into Lambda (runtime)
        └── Http.lambdaHttpServer
```

## Supported AWS Services

| Service         | Resources                                                    |
| --------------- | ------------------------------------------------------------ |
| **DynamoDB**    | Table                                                        |
| **EC2**         | VPC, Subnet, InternetGateway, RouteTable, SecurityGroup, ... |
| **EventBridge** | Rule, EventBus                                               |
| **IAM**         | Role, Policy                                                 |
| **Kinesis**     | Stream                                                       |
| **Lambda**      | Function                                                     |
| **S3**          | Bucket, GetObject, PutObject, Notifications                  |
| **SQS**         | Queue, SendMessage, QueueSink, EventSource                   |

## License

Apache-2.0
