/**
 * @since 4.0.0
 */
import * as Bash from "./internal/completions/bash.ts"
import type * as CommandDescriptor from "./internal/completions/CommandDescriptor.ts"
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
 * Generates a shell completion script for a command descriptor.
 *
 * @since 4.0.0
 * @category constructors
 */
export const generate = (
  executableName: string,
  shell: Shell,
  descriptor: CommandDescriptor.CommandDescriptor
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
