import { compileDeclarativeMatchers, type DeepsecPlugin } from "deepsec/config";

const specs = [
  {
    "version": 1,
    "slug": "effect-maple-internal-api-group",
    "description": "Detects Effect HttpApi handler groups registered specifically against MapleInternalApi.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/api/src/routes/internal/*.http.ts"
    ],
    "patterns": [
      {
        "source": "^export const Http[A-Za-z0-9]+Live\\s*=\\s*HttpApiBuilder\\.group\\(\\s*MapleInternalApi\\s*,",
        "flags": "m",
        "label": "Maple internal Effect HttpApi group registration"
      }
    ],
    "examples": [
      "export const HttpAiTriageLive = HttpApiBuilder.group(MapleInternalApi, \"aiTriage\", (handlers) =>",
      "export const HttpAiSessionsInternalLive = HttpApiBuilder.group(\n  MapleInternalApi,\n  \"aiSessionsInternal\","
    ],
    "closesSurfaceIds": [
      "dashboard-internal-http"
    ]
  },
  {
    "version": 1,
    "slug": "cloudflare-worker-queue-dispatch",
    "description": "Detects the API Worker's Cloudflare queue entrypoint and its binding-name dispatch primitive.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/api/src/worker.ts",
      "apps/api/src/queue-dispatch.ts"
    ],
    "patterns": [
      {
        "source": "^export const classifyWorkerQueue = \\(queueName: string, env: Record<string, unknown>\\): WorkerQueueKind => \\{$",
        "flags": "m",
        "label": "Cloudflare queue binding classifier"
      },
      {
        "source": "^\\s*override queue\\(batch: MessageBatch<unknown>\\): Promise<void> \\{$",
        "flags": "m",
        "label": "Cloudflare Worker queue entrypoint"
      }
    ],
    "examples": [
      "export const classifyWorkerQueue = (queueName: string, env: Record<string, unknown>): WorkerQueueKind => {",
      "  override queue(batch: MessageBatch<unknown>): Promise<void> {"
    ],
    "closesSurfaceIds": [
      "api-queue-consumers"
    ]
  },
  {
    "version": 1,
    "slug": "cloudflare-durable-workflow-entrypoint",
    "description": "Detects concrete Cloudflare WorkflowEntrypoint subclasses exported as durable workflow handlers.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/api/src/workflows/*Workflow.ts"
    ],
    "patterns": [
      {
        "source": "^export class [A-Za-z][A-Za-z0-9]*Workflow extends WorkflowEntrypoint<$",
        "flags": "m",
        "label": "Cloudflare durable workflow entrypoint"
      }
    ],
    "examples": [
      "export class ClickHouseSchemaApplyWorkflow extends WorkflowEntrypoint<",
      "export class InvestigationFanoutWorkflow extends WorkflowEntrypoint<"
    ],
    "closesSurfaceIds": [
      "cloudflare-workflows"
    ]
  },
  {
    "version": 1,
    "slug": "maple-otlp-axum-routes",
    "description": "Detects Maple ingest HTTP endpoints at their concrete Axum Router registrations.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/ingest/src/main.rs"
    ],
    "patterns": [
      {
        "source": "^\\s*\\.route\\(\"/(?:health|ready)\", get\\((?:health|ready)\\)\\)$",
        "flags": "m",
        "label": "Axum ingest health registration"
      },
      {
        "source": "^\\s*\\.route\\(\"/v1/(?:traces|logs|metrics)\", post\\(handle_(?:traces|logs|metrics)\\)\\)$",
        "flags": "m",
        "label": "Axum OTLP HTTP registration"
      },
      {
        "source": "^\\s*\\.route\\(\"/v1/sessionReplays/(?:meta|blob)\", post\\(handle_replay_(?:meta|blob)\\)\\)$",
        "flags": "m",
        "label": "Axum session replay registration"
      },
      {
        "source": "^\\s*\\.route\\(\"/v1/(?:sessionEvents|events)\", post\\(handle_(?:session_events|product_events)\\)\\)$",
        "flags": "m",
        "label": "Axum product or session event registration"
      },
      {
        "source": "^\\s*\\.route\\(\\s*\\n\\s*\"/v1/logpush/cloudflare/http_requests/\\{connector_id\\}\",\\s*\\n\\s*post\\(handle_cloudflare_logpush_http_requests\\),\\s*\\n\\s*\\)$",
        "flags": "m",
        "label": "Axum Cloudflare Logpush registration"
      }
    ],
    "examples": [
      "        .route(\"/health\", get(health))",
      "        .route(\"/v1/traces\", post(handle_traces))",
      "        .route(\"/v1/sessionReplays/blob\", post(handle_replay_blob))",
      "        .route(\"/v1/events\", post(handle_product_events))",
      "        .route(\n            \"/v1/logpush/cloudflare/http_requests/{connector_id}\",\n            post(handle_cloudflare_logpush_http_requests),\n        )"
    ],
    "closesSurfaceIds": [
      "ingest-http"
    ]
  },
  {
    "version": 1,
    "slug": "maple-otlp-tonic-services",
    "description": "Detects OTLP trace, log, and metric services at their concrete Tonic server registrations.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/ingest/src/main.rs"
    ],
    "patterns": [
      {
        "source": "^\\s*\\.add_service\\((?:TraceServiceServer::new\\(GrpcTraceService|LogsServiceServer::new\\(GrpcLogsService|MetricsServiceServer::new\\(GrpcMetricsService)\\b",
        "flags": "m",
        "label": "Tonic OTLP service registration"
      }
    ],
    "examples": [
      "        .add_service(TraceServiceServer::new(GrpcTraceService {",
      "        .add_service(LogsServiceServer::new(GrpcLogsService {",
      "        .add_service(MetricsServiceServer::new(GrpcMetricsService { state }));"
    ],
    "closesSurfaceIds": [
      "ingest-otlp-grpc"
    ]
  },
  {
    "version": 1,
    "slug": "electric-sync-worker-entry",
    "description": "Detects the Electric synchronization router's Effect web-handler construction and Cloudflare fetch export.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/electric-sync/src/worker.ts"
    ],
    "patterns": [
      {
        "source": "^\\s*return HttpRouter\\.toWebHandler\\($",
        "flags": "m",
        "label": "Effect router web-handler registration"
      },
      {
        "source": "^export default \\{\\s*fetch: \\(request: Request, env: Record<string, unknown>, ctx: ExecutionContext\\) =>\\s*handle\\(request, env, ctx\\),\\s*\\}$",
        "flags": "m",
        "label": "Electric sync Cloudflare fetch entrypoint"
      }
    ],
    "examples": [
      "  return HttpRouter.toWebHandler(",
      "export default {\n  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>\n    handle(request, env, ctx),\n}"
    ],
    "closesSurfaceIds": [
      "electric-shape-proxy"
    ]
  },
  {
    "version": 1,
    "slug": "eve-mcp-approval-policy",
    "description": "Detects the Slack agent's Eve MCP approval callback and its registration on the Maple connection.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/slack-agent/agent/connections/maple.ts",
      "apps/slack-agent/agent/lib/approval.ts"
    ],
    "patterns": [
      {
        "source": "^export function mapleToolApproval\\(ctx: ApprovalContext\\): ApprovalStatus \\{$",
        "flags": "m",
        "label": "Eve MCP approval callback"
      },
      {
        "source": "^\\s*approval: mapleToolApproval,$",
        "flags": "m",
        "label": "Eve MCP connection approval hook registration"
      }
    ],
    "examples": [
      "export function mapleToolApproval(ctx: ApprovalContext): ApprovalStatus {",
      "  approval: mapleToolApproval,"
    ],
    "closesSurfaceIds": [
      "slack-agent-tools"
    ]
  },
  {
    "version": 1,
    "slug": "eve-disabled-framework-tool",
    "description": "Detects Eve framework tools explicitly registered as disabled at the Slack agent tool boundary.",
    "noiseTier": "precise",
    "filePatterns": [
      "apps/slack-agent/agent/tools/*.ts"
    ],
    "patterns": [
      {
        "source": "^export default disableTool\\(\\)$",
        "flags": "m",
        "label": "Disabled Eve framework tool registration"
      }
    ],
    "excludeFilePatterns": [
      "**/*.test.ts",
      "**/*.spec.ts"
    ],
    "examples": [
      "export default disableTool()"
    ],
    "closesSurfaceIds": [
      "slack-agent-tools"
    ]
  }
];

export const generatedMatchersPlugin: DeepsecPlugin = {
  name: "deepsec-generated-matchers",
  matchers: compileDeclarativeMatchers(specs),
};
