import { Context } from "effect"

export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}
