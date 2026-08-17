// `TimeRangeSchema` moved to `@maple/query-model` — alert previews, MCP tools
// and the explore pages all resolve the same shape, so it is not a dashboard
// concept. Re-exported here so `shared/document.ts`, `shared/widget.ts` and
// `@maple/domain/http` keep their existing surface.
export { type TimeRange, TimeRangeSchema } from "@maple/query-model"
