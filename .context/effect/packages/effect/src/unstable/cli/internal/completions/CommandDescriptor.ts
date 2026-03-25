/**
 * CommandDescriptor — pure-data representation of a command tree for
 * shell completion generation.
 *
 * @internal
 */
import * as Option from "../../../../Option.ts"
import type { Command } from "../../Command.ts"
import * as Param from "../../Param.ts"
import * as Primitive from "../../Primitive.ts"
import { toImpl } from "../command.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @internal */
export interface CommandDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly flags: ReadonlyArray<FlagDescriptor>
  readonly arguments: ReadonlyArray<ArgumentDescriptor>
  readonly subcommands: ReadonlyArray<CommandDescriptor>
}

/** @internal */
export interface FlagDescriptor {
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly description: string | undefined
  readonly type: FlagType
}

/** @internal */
export type FlagType =
  | { readonly _tag: "Boolean" }
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }

/** @internal */
export interface ArgumentDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly required: boolean
  readonly variadic: boolean
  readonly type: ArgumentType
}

/** @internal */
export type ArgumentType =
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toFlagType = (single: Param.Single<"flag", unknown>): FlagType => {
  const tag = single.primitiveType._tag
  switch (tag) {
    case "Boolean":
      return { _tag: "Boolean" }
    case "Integer":
      return { _tag: "Integer" }
    case "Float":
      return { _tag: "Float" }
    case "Date":
      return { _tag: "Date" }
    case "Choice": {
      const keys = Primitive.getChoiceKeys(single.primitiveType)
      return { _tag: "Choice", values: keys ?? [] }
    }
    case "Path": {
      const typeName = single.typeName
      const pathType: "file" | "directory" | "either" = typeName === "file"
        ? "file"
        : typeName === "directory"
        ? "directory"
        : "either"
      return { _tag: "Path", pathType }
    }
    default:
      return { _tag: "String" }
  }
}

const toArgumentType = (single: Param.Single<"argument", unknown>): ArgumentType => {
  const tag = single.primitiveType._tag
  switch (tag) {
    case "Integer":
      return { _tag: "Integer" }
    case "Float":
      return { _tag: "Float" }
    case "Date":
      return { _tag: "Date" }
    case "Choice": {
      const keys = Primitive.getChoiceKeys(single.primitiveType)
      return { _tag: "Choice", values: keys ?? [] }
    }
    case "Path": {
      const typeName = single.typeName
      const pathType: "file" | "directory" | "either" = typeName === "file"
        ? "file"
        : typeName === "directory"
        ? "directory"
        : "either"
      return { _tag: "Path", pathType }
    }
    default:
      return { _tag: "String" }
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** @internal */
export const fromCommand = (cmd: Command.Any): CommandDescriptor => {
  const impl = toImpl(cmd)
  const config = impl.config

  const flags: Array<FlagDescriptor> = []
  for (const flag of config.flags) {
    const singles = Param.extractSingleParams(flag)
    for (const single of singles) {
      if (single.kind !== "flag") continue
      flags.push({
        name: single.name,
        aliases: single.aliases,
        description: Option.getOrUndefined(single.description),
        type: toFlagType(single as Param.Single<"flag", unknown>)
      })
    }
  }

  const args: Array<ArgumentDescriptor> = []
  for (const arg of config.arguments) {
    const singles = Param.extractSingleParams(arg)
    const metadata = Param.getParamMetadata(arg)
    for (const single of singles) {
      if (single.kind !== "argument") continue
      args.push({
        name: single.name,
        description: Option.getOrUndefined(single.description),
        required: !metadata.isOptional,
        variadic: metadata.isVariadic,
        type: toArgumentType(single as Param.Single<"argument", unknown>)
      })
    }
  }

  const subcommands: Array<CommandDescriptor> = []
  for (const group of cmd.subcommands) {
    for (const subcommand of group.commands) {
      subcommands.push(fromCommand(subcommand))
    }
  }

  return {
    name: cmd.name,
    description: cmd.shortDescription ?? cmd.description,
    flags,
    arguments: args,
    subcommands
  }
}
