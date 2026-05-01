// ---------------------------------------------------------------------------
// Drain log template-mining library — pure-TypeScript port of Drain3
//
// Vendored from https://github.com/hyperdxio/hyperdx
//   (packages/common-utils/src/drain) which itself is a port of
//   https://github.com/DeploySentinel/browser-drain
// Both upstream sources are MIT-licensed (Copyright (c) 2023 DeploySentinel,
// Inc.). No behavioural changes; reformatted to match the project's
// trailing-comma style during typecheck.
// ---------------------------------------------------------------------------

export type { MaskingInstructionConfig } from "./config"
export { TemplateMinerConfig } from "./config"
export { Drain } from "./drain"
export { LogCluster } from "./log-cluster"
export { LruCache } from "./lru-cache"
export { LogMasker, MaskingInstruction } from "./masking"
export { Node } from "./node"
export type { AddLogMessageResult, ExtractedParameter } from "./template-miner"
export { TemplateMiner } from "./template-miner"
