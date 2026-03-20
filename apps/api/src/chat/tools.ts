import {
  AddDashboardWidgetToolOutput,
  DiagnoseServiceToolOutput,
  ErrorDetailToolOutput,
  FindErrorsToolOutput,
  FindSlowTracesToolOutput,
  InspectTraceToolOutput,
  ListMetricsToolOutput,
  QueryDataToolOutput,
  RemoveDashboardWidgetToolOutput,
  SearchLogsToolOutput,
  SearchTracesToolOutput,
  ServiceOverviewToolOutput,
  SystemHealthToolOutput,
  chatToolMetadata,
  type ChatMode,
  type DashboardWidgetProposal,
  type DashboardWidgetRemoval,
} from "@maple/domain"
import { Tool, Toolkit } from "effect/unstable/ai"
import { Effect, Layer, ServiceMap } from "effect"
import { CurrentTenantContextLive } from "@/mcp/lib/current-tenant-context"
import { ApiKeysService } from "@/services/ApiKeysService"
import { AuthService } from "@/services/AuthService"
import { Env } from "@/services/Env"
import { QueryEngineService } from "@/services/QueryEngineService"
import { TinybirdService } from "@/services/TinybirdService"
import { ChatToolFailure } from "./errors"
import { observabilityToolExecutors } from "./observability-tools"
import { ChatRequestContext } from "./request-context"

const failureOptions = {
  failure: ChatToolFailure,
  failureMode: "return" as const,
}

const SystemHealthTool = Tool.make("system_health", {
  description: chatToolMetadata.system_health.description,
  parameters: chatToolMetadata.system_health.inputSchema,
  success: SystemHealthToolOutput,
  ...failureOptions,
})

const FindErrorsTool = Tool.make("find_errors", {
  description: chatToolMetadata.find_errors.description,
  parameters: chatToolMetadata.find_errors.inputSchema,
  success: FindErrorsToolOutput,
  ...failureOptions,
})

const InspectTraceTool = Tool.make("inspect_trace", {
  description: chatToolMetadata.inspect_trace.description,
  parameters: chatToolMetadata.inspect_trace.inputSchema,
  success: InspectTraceToolOutput,
  ...failureOptions,
})

const SearchLogsTool = Tool.make("search_logs", {
  description: chatToolMetadata.search_logs.description,
  parameters: chatToolMetadata.search_logs.inputSchema,
  success: SearchLogsToolOutput,
  ...failureOptions,
})

const SearchTracesTool = Tool.make("search_traces", {
  description: chatToolMetadata.search_traces.description,
  parameters: chatToolMetadata.search_traces.inputSchema,
  success: SearchTracesToolOutput,
  ...failureOptions,
})

const ServiceOverviewTool = Tool.make("service_overview", {
  description: chatToolMetadata.service_overview.description,
  parameters: chatToolMetadata.service_overview.inputSchema,
  success: ServiceOverviewToolOutput,
  ...failureOptions,
})

const DiagnoseServiceTool = Tool.make("diagnose_service", {
  description: chatToolMetadata.diagnose_service.description,
  parameters: chatToolMetadata.diagnose_service.inputSchema,
  success: DiagnoseServiceToolOutput,
  ...failureOptions,
})

const FindSlowTracesTool = Tool.make("find_slow_traces", {
  description: chatToolMetadata.find_slow_traces.description,
  parameters: chatToolMetadata.find_slow_traces.inputSchema,
  success: FindSlowTracesToolOutput,
  ...failureOptions,
})

const ErrorDetailTool = Tool.make("error_detail", {
  description: chatToolMetadata.error_detail.description,
  parameters: chatToolMetadata.error_detail.inputSchema,
  success: ErrorDetailToolOutput,
  ...failureOptions,
})

const ListMetricsTool = Tool.make("list_metrics", {
  description: chatToolMetadata.list_metrics.description,
  parameters: chatToolMetadata.list_metrics.inputSchema,
  success: ListMetricsToolOutput,
  ...failureOptions,
})

const QueryDataTool = Tool.make("query_data", {
  description: chatToolMetadata.query_data.description,
  parameters: chatToolMetadata.query_data.inputSchema,
  success: QueryDataToolOutput,
  ...failureOptions,
})

const AddDashboardWidgetTool = Tool.make("add_dashboard_widget", {
  description: chatToolMetadata.add_dashboard_widget.description,
  parameters: chatToolMetadata.add_dashboard_widget.inputSchema,
  success: AddDashboardWidgetToolOutput,
  ...failureOptions,
})

const RemoveDashboardWidgetTool = Tool.make("remove_dashboard_widget", {
  description: chatToolMetadata.remove_dashboard_widget.description,
  parameters: chatToolMetadata.remove_dashboard_widget.inputSchema,
  success: RemoveDashboardWidgetToolOutput,
  ...failureOptions,
})

const ObservabilityToolkit = Toolkit.make(
  SystemHealthTool,
  FindErrorsTool,
  InspectTraceTool,
  SearchLogsTool,
  SearchTracesTool,
  ServiceOverviewTool,
  DiagnoseServiceTool,
  FindSlowTracesTool,
  ErrorDetailTool,
  ListMetricsTool,
  QueryDataTool,
)

const DashboardToolkit = Toolkit.merge(
  ObservabilityToolkit,
  Toolkit.make(AddDashboardWidgetTool, RemoveDashboardWidgetTool),
)

const toolFailure = (message: string, details?: string[]) =>
  new ChatToolFailure({ message, details })

const makeObservabilityHandlers = Effect.gen(function* () {
  const env = yield* Env
  const tinybird = yield* TinybirdService
  const queryEngine = yield* QueryEngineService
  const auth = yield* AuthService
  const apiKeys = yield* ApiKeysService
  const requestContext = yield* ChatRequestContext

  const serviceLayer = Layer.mergeAll(
    CurrentTenantContextLive(requestContext.tenant),
    Layer.succeed(TinybirdService)(tinybird),
    Layer.succeed(QueryEngineService)(queryEngine),
    Layer.succeed(Env)(env),
    Layer.succeed(AuthService)(auth),
    Layer.succeed(ApiKeysService)(apiKeys),
  )

  const runTool = <TParams, TResult, TError extends { message: string }, R>(
    name: string,
    execute: (params: TParams) => Effect.Effect<TResult, TError, R>,
  ) =>
    (params: TParams): Effect.Effect<TResult, ChatToolFailure, never> =>
      execute(params).pipe(
        Effect.mapError((error) => toolFailure(error.message)),
        Effect.catchDefect((defect) =>
          Effect.fail(
            toolFailure(`Internal error while executing ${name}`, [
              defect instanceof Error ? defect.message : String(defect),
            ]),
          ),
        ),
        Effect.provide(serviceLayer),
      ) as Effect.Effect<TResult, ChatToolFailure, never>

  return {
    system_health: runTool("system_health", observabilityToolExecutors.system_health),
    find_errors: runTool("find_errors", observabilityToolExecutors.find_errors),
    inspect_trace: runTool("inspect_trace", observabilityToolExecutors.inspect_trace),
    search_logs: runTool("search_logs", observabilityToolExecutors.search_logs),
    search_traces: runTool("search_traces", observabilityToolExecutors.search_traces),
    service_overview: runTool("service_overview", observabilityToolExecutors.service_overview),
    diagnose_service: runTool("diagnose_service", observabilityToolExecutors.diagnose_service),
    find_slow_traces: runTool("find_slow_traces", observabilityToolExecutors.find_slow_traces),
    error_detail: runTool("error_detail", observabilityToolExecutors.error_detail),
    list_metrics: runTool("list_metrics", observabilityToolExecutors.list_metrics),
    query_data: runTool("query_data", observabilityToolExecutors.query_data),
  }
})

const addDashboardWidget = (params: DashboardWidgetProposal) =>
  Effect.succeed({
    tool: "add_dashboard_widget" as const,
    summaryText: `Proposed ${params.visualization} widget "${params.display.title ?? "Untitled Widget"}".`,
    data: params,
  })

const removeDashboardWidget = (params: DashboardWidgetRemoval) =>
  Effect.succeed({
    tool: "remove_dashboard_widget" as const,
    summaryText: `Proposed removing widget "${params.widgetTitle}".`,
    data: params,
  })

const buildObservabilityToolkit = Effect.gen(function* () {
  return yield* ObservabilityToolkit
}).pipe(
  Effect.provide(ObservabilityToolkit.toLayer(makeObservabilityHandlers)),
)

const buildDashboardToolkit = Effect.gen(function* () {
  return yield* DashboardToolkit
}).pipe(
  Effect.provide(
    DashboardToolkit.toLayer(
      Effect.gen(function* () {
        const observabilityHandlers = yield* makeObservabilityHandlers
        return {
          ...observabilityHandlers,
          add_dashboard_widget: addDashboardWidget,
          remove_dashboard_widget: removeDashboardWidget,
        }
      }),
    ),
  ),
)

export class ChatToolkitService extends ServiceMap.Service<ChatToolkitService>()(
  "ChatToolkitService",
  {
    make: Effect.gen(function* () {
      const buildForMode = Effect.fn("ChatToolkitService.buildForMode")(function* (
        mode: ChatMode,
      ) {
        return yield* (mode === "dashboard_builder"
          ? buildDashboardToolkit
          : buildObservabilityToolkit)
      })

      return {
        buildForMode,
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
