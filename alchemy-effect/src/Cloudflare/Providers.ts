import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";
import { Command } from "../Build/Command.ts";
import * as Build from "../Build/index.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import * as Account from "./Account.ts";
import * as Containers from "./Container/index.ts";
import * as D1 from "./D1/index.ts";
import * as KV from "./KV/index.ts";
import * as R2 from "./R2/index.ts";
import * as Assets from "./Workers/Assets.ts";
import * as Workers from "./Workers/index.ts";
import * as Workflows from "./Workers/Workflow.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Cloudflare",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Cloudflare providers, bindings, and credentials for Worker-based stacks.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Command,
      Containers.Container,
      D1.D1ConnectionPolicy,
      D1.D1Database,
      KV.KVNamespace,
      KV.KVNamespaceBindingPolicy,
      R2.R2Bucket,
      R2.R2BucketBindingPolicy,
      Random,
      Workers.BindWorkerPolicy,
      Workers.FetchPolicy,
      Workers.Worker,
      Workflows.WorkflowResource,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Containers.ContainerProvider(),
        D1.D1ConnectionPolicyLive,
        D1.DatabaseProvider(),
        KV.KVNamespaceBindingPolicyLive,
        KV.KVNamespaceProvider(),
        R2.R2BucketBindingPolicyLive,
        R2.R2BucketProvider(),
        Workers.BindWorkerPolicyLive,
        Workers.FetchPolicyLive,
        Workers.WorkerProvider(),
        Workflows.WorkflowProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Assets.AssetsProvider(),
        Build.CommandProvider(),
        RandomProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Account.fromStageConfig(),
        Auth.fromEnv(),
        Socket.layerWebSocketConstructorGlobal,
      ),
    ),
    Layer.orDie,
  );
