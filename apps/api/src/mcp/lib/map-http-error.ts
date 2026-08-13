import type { SelfDescribingHttpError } from "@maple/domain/http"
import { McpQueryError } from "@/mcp/tools/types"

/** Adapt an HTTP-domain failure at the MCP protocol boundary without reclassifying its tag. */
export const toMcpHttpError =
	(pipeName: string) =>
	(error: SelfDescribingHttpError): McpQueryError =>
		new McpQueryError({
			message: `${error._tag}: ${error.error.message}`,
			pipeName,
			cause: error,
		})
