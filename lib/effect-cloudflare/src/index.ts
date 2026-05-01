// ---------------------------------------------------------------------------
// Core HTTP primitives
// ---------------------------------------------------------------------------
export { type HttpEffect, Request, safeHttpEffect } from "./http.ts"
export { serveWebRequest } from "./http-server.ts"

// ---------------------------------------------------------------------------
// Per-request / per-invocation runtime (maple-specific)
// ---------------------------------------------------------------------------
export {
	buildRequestRuntime,
	type ExecutionContextLike,
	type Flushable,
	layerFromEnv,
	runScheduledEffect,
	withRequestRuntime,
} from "./runtime.ts"

// ---------------------------------------------------------------------------
// Worker env + config (from alchemy-effect)
// ---------------------------------------------------------------------------
export { default as cloudflareWorkers } from "./cloudflare-workers.ts"
export { WorkerConfigProvider, WorkerConfigProviderLive } from "./config-provider.ts"
export { WorkerEnvironment, WorkerEnvironmentLive, layerFromEnvRecord } from "./worker-environment.ts"

// ---------------------------------------------------------------------------
// Durable Objects
// ---------------------------------------------------------------------------
export { DurableObjectState, fromDurableObjectState } from "./durable-object-state.ts"
export {
	type DurableObjectStorage,
	type DurableObjectTransaction,
	fromDurableObjectStorage,
	fromDurableObjectTransaction,
	type SqlCursor,
	type SqlStorage,
	type SqlStorageValue,
} from "./durable-object-storage.ts"
export {
	type DurableObjectId,
	type AlarmInvocationInfo,
	type DurableObjectShape,
	type DurableObjectStub,
	type DurableObjectNamespaceHandle,
	DurableObjectNamespace,
	namespaceOf,
	registerDurableObjectImpl,
	getDurableObjectImpl,
} from "./durable-object-namespace.ts"
export { type DurableWebSocket, type RawWebSocket, fromWebSocket, upgrade } from "./websocket.ts"
export {
	type ScheduledEvent,
	scheduleEvent,
	cancelEvent,
	listEvents,
	processScheduledEvents,
} from "./scheduled-events.ts"

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------
export {
	type WorkflowBody,
	type WorkflowHandle,
	type WorkflowInstance,
	type WorkflowInstanceStatus,
	type WorkflowRunServices,
	Workflow,
	WorkflowEvent,
	WorkflowStep,
	registerWorkflowImpl,
	sleep,
	sleepUntil,
	task,
	workflowHandle,
} from "./workflow.ts"

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------
export {
	decodeRpcResult,
	decodeRpcValue,
	encodeRpcError,
	ErrorTag,
	fromRpcReadableStream,
	fromRpcStreamEnvelope,
	isRpcErrorEnvelope,
	isRpcStreamEnvelope,
	isRpcStreamErrorMarker,
	makeDurableObjectBridge,
	makeRpcStub,
	makeWorkflowBridge,
	RpcCallError,
	RpcDecodeError,
	RpcRemoteStreamError,
	type RpcErrorEnvelope,
	type RpcStreamEnvelope,
	type RpcStreamErrorMarker,
	StreamErrorTag,
	StreamTag,
	toRpcStream,
} from "./rpc.ts"

// ---------------------------------------------------------------------------
// Storage bindings (runtime clients)
// ---------------------------------------------------------------------------
export { D1Connection, D1Database, type D1ConnectionClient, type D1DatabaseToken } from "./d1-connection.ts"
export {
	KVNamespace,
	KVNamespaceError,
	type KVNamespaceClient,
	type KVNamespaceToken,
} from "./kv-namespace.ts"
export {
	R2Bucket,
	R2Error,
	type R2BucketClient,
	type R2BucketToken,
	type R2GetOptions,
	type R2ListOptions,
	type R2MultipartUpload,
	type R2Object,
	type R2ObjectBody,
	type R2Objects,
	type R2PutOptions,
} from "./r2-bucket.ts"

// ---------------------------------------------------------------------------
// Outbound fetch (service bindings)
// ---------------------------------------------------------------------------
export { ServiceBinding, type ServiceBindingFetch, type ServiceBindingToken } from "./fetch.ts"
export {
	type Fetcher,
	type SocketAddress,
	type SocketOptions,
	fromCloudflareFetcher,
	fromCloudflareSocket,
	toCloudflareFetcher,
} from "./fetcher.ts"
