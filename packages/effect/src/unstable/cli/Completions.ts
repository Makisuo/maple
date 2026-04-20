/**
 * Shell completion descriptors and script generation for the unstable CLI API.
 *
 * @since 4.0.0
 */
import * as Bash from "./internal/completions/bash.ts"
import * as Fish from "./internal/completions/fish.ts"
import * as Zsh from "./internal/completions/zsh.ts"

/**
 * Shell type used to generate completion scripts.
 *
 * @since 4.0.0
 * @category models
 */
export type Shell = "bash" | "zsh" | "fish"

/**
 * Describes a command for completion script generation.
 *
 * @since 4.0.0
 * @category models
 */
export interface CommandDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly flags: ReadonlyArray<FlagDescriptor>
  readonly arguments: ReadonlyArray<ArgumentDescriptor>
  readonly subcommands: ReadonlyArray<CommandDescriptor>
}

/**
 * Describes a command flag for completions.
 *
 * @since 4.0.0
 * @category models
 */
export interface FlagDescriptor {
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly description: string | undefined
  readonly type: FlagType
}

/**
 * Describes the supported flag value shapes.
 *
 * @since 4.0.0
 * @category models
 */
export type FlagType =
  | { readonly _tag: "Boolean" }
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }

/**
 * Describes a positional argument for completions.
 *
 * @since 4.0.0
 * @category models
 */
export interface ArgumentDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly required: boolean
  readonly variadic: boolean
  readonly type: ArgumentType
}

/**
 * Describes the supported argument value shapes.
 *
 * @since 4.0.0
 * @category models
 */
export type ArgumentType =
  | { readonly _tag: "String" }
  | { readonly _tag: "Integer" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Path"; readonly pathType: "file" | "directory" | "either" }

/**
 * Generates a shell completion script for a command descriptor.
 *
 * @since 4.0.0
 * @category constructors
 */
export const generate = (
  executableName: string,
  shell: Shell,
  descriptor: CommandDescriptor
): string => {
  switch (shell) {
    case "bash":
      return Bash.generate(executableName, descriptor)
    case "zsh":
      return Zsh.generate(executableName, descriptor)
    case "fish":
      return Fish.generate(executableName, descriptor)
  }
}
