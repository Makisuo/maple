import * as Auth from "@distilled.cloud/cloudflare/Auth";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Socket from "effect/unstable/socket/Socket";
import { CommandProvider } from "../Build/Command.ts";
import type { Provider } from "../Provider.ts";
import { RandomProvider } from "../Random.ts";
import * as Account from "./Account.ts";
import { ContainerProvider } from "./Container/ContainerApplication.ts";
import * as D1 from "./D1/index.ts";
import * as KV from "./KV/index.ts";
import * as R2 from "./R2/index.ts";
import { AssetsProvider } from "./Workers/Assets.ts";
import { WorkerProvider } from "./Workers/Worker.ts";
import { WorkflowProvider } from "./Workers/Workflow.ts";

export type Providers = Extract<
  Layer.Success<ReturnType<typeof providers>>,
  Provider<any>
>;

/**
 * Cloudflare providers, bindings, and credentials for Worker-based stacks.
 */
export const providers = () =>
  pipe(
    resources(),
    Layer.provideMerge(bindings()),
    Layer.provideMerge(utils()),
    Layer.provideMerge(credentials()),
    Layer.orDie,
  );

/**
 * Cloudflare account credentials and auth context.
 */
export const credentials = () =>
  Layer.mergeAll(
    Account.fromStageConfig(),
    Layer.provideMerge(Auth.fromEnv(), FetchHttpClient.layer),
  );

/**
 * All Cloudflare resource providers.
 */
export const resources = () =>
  Layer.mergeAll(
    CommandProvider(),
    RandomProvider(),
    ContainerProvider(),
    WorkerProvider(),
    WorkflowProvider(),
    D1.DatabaseProvider(),
    KV.NamespaceProvider(),
    R2.R2BucketProvider(),
  );

/**
 * All Cloudflare binding policies.
 */
export const bindings = () =>
  Layer.mergeAll(
    D1.D1ConnectionPolicyLive,
    R2.R2BucketBindingPolicyLive,
    KV.KVNamespaceBindingPolicyLive,
  );

const utils = () =>
  Layer.mergeAll(AssetsProvider(), Socket.layerWebSocketConstructorGlobal);
