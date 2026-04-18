import { Context } from "effect"

export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Record<string, unknown>
>()("Cloudflare.Workers.WorkerEnvironment") {}
