// Thin re-export of the runtime-shared `WorkerEnvironment` from
// `@maple/effect-cloudflare`. The shared service uses the same tag
// (`"Cloudflare.Workers.WorkerEnvironment"`) so provision is compatible with
// any prior in-tree usage.
export { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
