import { Effect, Schema, ServiceMap } from "effect"
import { type AiError, LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { describe, expect, it } from "tstyche"

const FailureModeErrorTool = Tool.make("FailureModeErrorTool", {
  parameters: Schema.Struct({
    input: Schema.String
  }),
  success: Schema.Struct({
    output: Schema.String
  }),
  failure: Schema.Struct({
    message: Schema.String
  })
})

class RequestContext extends ServiceMap.Service<RequestContext, {
  readonly requestId: string
}>()("RequestContext") {}

class ToolkitContext extends ServiceMap.Service<ToolkitContext, {
  readonly tenantId: string
}>()("ToolkitContext") {}

const ToolWithRequestContext = Tool.make("ToolWithRequestContext", {
  parameters: Schema.Struct({
    input: Schema.String
  }),
  success: Schema.Struct({
    output: Schema.String
  }),
  dependencies: [RequestContext]
})

describe("LanguageModel", () => {
  describe("generateText", () => {
    it("tool handlers do not leak AiErrorReason into the error channel", () => {
      const toolkit = Toolkit.make(FailureModeErrorTool)
      const program = LanguageModel.generateText({
        prompt: "hello",
        toolkit
      })

      type ProgramError = typeof program extends Effect.Effect<any, infer E, any> ? E : never

      expect<ProgramError>().type.toBe<AiError.AiError | { readonly message: string }>()
      expect<Extract<ProgramError, AiError.AiErrorReason>>().type.toBe<never>()
    })

    it("includes tool request dependencies when a toolkit is provided", () => {
      const toolkit = Toolkit.make(ToolWithRequestContext)
      const program = LanguageModel.generateText({
        prompt: "hello",
        toolkit
      })

      type ProgramRequirements = typeof program extends Effect.Effect<any, any, infer R> ? R : never

      expect<ProgramRequirements>().type.toBe<
        LanguageModel.LanguageModel | RequestContext | Tool.HandlersFor<Toolkit.Tools<typeof toolkit>>
      >()
    })

    it("includes tool request dependencies for resolved toolkits with handlers", () => {
      const toolkit: Toolkit.WithHandler<{
        readonly ToolWithRequestContext: typeof ToolWithRequestContext
      }> = {
        tools: {
          ToolWithRequestContext
        },
        handle: () => Effect.die("not implemented")
      }
      const program = LanguageModel.generateText({
        prompt: "hello",
        toolkit
      })

      type ProgramRequirements = typeof program extends Effect.Effect<any, any, infer R> ? R : never

      expect<ProgramRequirements>().type.toBe<LanguageModel.LanguageModel | RequestContext>()
    })

    it("includes yieldable toolkit requirements and tool request dependencies", () => {
      type ToolWithRequestContextTools = {
        readonly ToolWithRequestContext: typeof ToolWithRequestContext
      }

      type YieldableToolkit = Effect.Yieldable<
        Toolkit.Toolkit<ToolWithRequestContextTools>,
        Toolkit.WithHandler<ToolWithRequestContextTools>,
        never,
        ToolkitContext
      >

      expect<LanguageModel.ExtractServices<{ readonly toolkit: YieldableToolkit }>>().type.toBe<
        RequestContext | ToolkitContext
      >()
    })

    it("supports toolkit unions in options", () => {
      const toolkitA = Toolkit.make(ToolWithRequestContext)
      const toolkitB = Toolkit.make(FailureModeErrorTool)
      const cond = Math.random() > 0.5
      const toolkit = cond ? toolkitA : toolkitB
      type ToolkitUnionHandlers =
        | Tool.Handler<"ToolWithRequestContext">
        | Tool.Handler<"FailureModeErrorTool">

      const program = LanguageModel.generateText({
        prompt: "hello",
        toolkit
      })

      type ProgramError = typeof program extends Effect.Effect<any, infer E, any> ? E : never
      type ProgramRequirements = typeof program extends Effect.Effect<any, any, infer R> ? R : never

      expect<ProgramError>().type.toBe<AiError.AiError | { readonly message: string }>()
      expect<ProgramRequirements>().type.toBe<
        LanguageModel.LanguageModel | RequestContext | ToolkitUnionHandlers
      >()
    })

    it("extracts services and tools from toolkit unions", () => {
      const toolkitA = Toolkit.make(ToolWithRequestContext)
      const toolkitB = Toolkit.make(FailureModeErrorTool)

      type ToolkitUnion = typeof toolkitA | typeof toolkitB
      type ToolkitUnionHandlers =
        | Tool.Handler<"ToolWithRequestContext">
        | Tool.Handler<"FailureModeErrorTool">
      type ToolkitUnionTools =
        | { readonly ToolWithRequestContext: typeof ToolWithRequestContext }
        | { readonly FailureModeErrorTool: typeof FailureModeErrorTool }

      expect<LanguageModel.ExtractServices<{ readonly toolkit: ToolkitUnion }>>().type.toBe<
        RequestContext | ToolkitUnionHandlers
      >()
      expect<LanguageModel.ExtractTools<{ readonly toolkit: ToolkitUnion }>>().type.toBe<
        ToolkitUnionTools
      >()
    })
  })
})
