import { toRpcAsync } from "alchemy/Cloudflare/Bridge"
import type { MapleApiRpcShape } from "@maple/domain/internal-rpc"
import type { ChatFlueEnv } from "./env.ts"

/** Fresh per-invocation async facade over the API Worker service binding. */
export const mapleApiRpc = (env: ChatFlueEnv) => toRpcAsync<MapleApiRpcShape>(env.MAPLE_API_RPC)
