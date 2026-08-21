import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { CONNECTION_SEARCH_TOOL_NAME, extractConnectionSearchFailures } from "./connection-search-failures.js"

/**
 * A representative failure shape: the Maple MCP server rejected the protocol
 * version on `initialize`, eve retried over legacy SSE, and that 405'd.
 * `connection_search` still reports success in this case — the connection's
 * tools are simply absent from the turn.
 */
const MCP_405_ERROR =
	'Failed to load tools for "maple": MCPClientError: MCP SSE Transport Error: 405 Method Not Allowed.'

describe("extractConnectionSearchFailures", () => {
	test("reports a connection whose tools failed to load", () => {
		const failures = extractConnectionSearchFailures([
			{ connection: "maple", description: "Maple observability platform", error: MCP_405_ERROR },
		])

		expect(failures).toEqual([{ connection: "maple", error: MCP_405_ERROR }])
	})

	test("reads through eve's { type, value } result wrapper", () => {
		const failures = extractConnectionSearchFailures({
			type: "json",
			value: [{ connection: "maple", description: "Maple", error: MCP_405_ERROR }],
		})

		expect(failures).toHaveLength(1)
		expect(failures[0]?.connection).toBe("maple")
	})

	test("ignores discovered tools and pending authorizations", () => {
		// needsAuthorization is the ordinary OAuth handshake, not an outage; a
		// discovered tool carries no `error` at all.
		const failures = extractConnectionSearchFailures([
			{
				connection: "maple",
				description: "List services",
				qualifiedName: "maple__list_services",
				tool: "list_services",
			},
			{ connection: "linear", description: "Linear", needsAuthorization: true },
		])

		expect(failures).toEqual([])
	})

	test("survives an output shape it does not recognize", () => {
		for (const output of [undefined, null, "no tools found", 42, {}, [null, "x", { error: "" }]]) {
			expect(extractConnectionSearchFailures(output)).toEqual([])
		}
	})

	test("keeps the error when the connection name is missing", () => {
		expect(extractConnectionSearchFailures([{ error: MCP_405_ERROR }])).toEqual([
			{ connection: undefined, error: MCP_405_ERROR },
		])
	})
})

describe("connection_search tool name", () => {
	/**
	 * The hook matches `action.result` events by tool name, and a rename in eve
	 * would silently stop the forwarding rather than break the build. eve's own
	 * `extractDiscoveredTools` filters on the same literal, so feeding it a
	 * message built from our constant proves the two still agree.
	 */
	test("matches the name eve's own connection-search code filters on", async () => {
		const require_ = createRequire(import.meta.url)
		const eveRoot = new URL(".", `file://${require_.resolve("eve/package.json")}`).href
		// BOUNDARY: eve ships this internal dist module without types, so the
		// shape below is our own declaration of someone else's function. Naming a
		// domain type for `messages` would assert a contract eve never published;
		// the literal passed in is the only thing this test actually pins.
		const module_ = (await import(
			`${eveRoot}dist/src/runtime/framework-tools/connection-search-dynamic.js`
		)) as {
			extractDiscoveredTools(messages: unknown): ReadonlyArray<{ qualifiedName?: string }>
		}

		const discovered = module_.extractDiscoveredTools([
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolName: CONNECTION_SEARCH_TOOL_NAME,
						output: [
							{
								connection: "maple",
								description: "List services",
								qualifiedName: "maple__list_services",
								tool: "list_services",
							},
						],
					},
				],
			},
		])

		expect(
			discovered.map((tool) => tool.qualifiedName),
			`eve no longer calls its connection search tool "${CONNECTION_SEARCH_TOOL_NAME}"`,
		).toEqual(["maple__list_services"])
	})
})
