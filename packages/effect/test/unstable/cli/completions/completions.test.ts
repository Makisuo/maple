import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as Completions from "effect/unstable/cli/Completions"
import * as Bash from "effect/unstable/cli/internal/completions/bash"
import * as CommandDescriptor from "effect/unstable/cli/internal/completions/CommandDescriptor"
import * as Fish from "effect/unstable/cli/internal/completions/fish"
import * as Zsh from "effect/unstable/cli/internal/completions/zsh"
import { ComprehensiveCli } from "../fixtures/ComprehensiveCli.ts"

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const simpleCmd = Command.make("greet", {
  name: Argument.string("name").pipe(
    Argument.withDescription("Name to greet")
  ),
  loud: Flag.boolean("loud").pipe(
    Flag.withAlias("l"),
    Flag.withDescription("Shout the greeting")
  ),
  times: Flag.integer("times").pipe(
    Flag.withDescription("Repeat count"),
    Flag.withDefault(1)
  )
}).pipe(Command.withDescription("Greet someone"))

const withSubcommands = (() => {
  const start = Command.make("start", {
    port: Flag.integer("port").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Port number")
    ),
    daemon: Flag.boolean("daemon").pipe(
      Flag.withDescription("Run as daemon")
    )
  }).pipe(Command.withDescription("Start the server"))

  const stop = Command.make("stop", {
    force: Flag.boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Force stop")
    )
  }).pipe(Command.withDescription("Stop the server"))

  return Command.make("server", {
    verbose: Flag.boolean("verbose").pipe(Flag.withAlias("v"))
  }).pipe(
    Command.withDescription("Server management"),
    Command.withSubcommands([start, stop])
  )
})()

const withChoices = Command.make("deploy", {
  env: Flag.choice("env", ["dev", "staging", "prod"]).pipe(
    Flag.withDescription("Target environment")
  ),
  region: Argument.choice("region", ["us-east", "eu-west", "ap-south"]).pipe(
    Argument.withDescription("Deployment region")
  )
}).pipe(Command.withDescription("Deploy application"))

const withPaths = Command.make("process", {
  input: Flag.file("input").pipe(Flag.withDescription("Input file")),
  outDir: Flag.directory("output-dir").pipe(Flag.withDescription("Output directory")),
  source: Argument.file("source", { mustExist: false }).pipe(
    Argument.withDescription("Source file")
  )
}).pipe(Command.withDescription("Process files"))

const nested3Levels = (() => {
  const leaf = Command.make("action", {
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDescription("Dry run mode"))
  }).pipe(Command.withDescription("Perform action"))

  const mid = Command.make("sub").pipe(
    Command.withSubcommands([leaf])
  )

  return Command.make("top").pipe(
    Command.withSubcommands([mid])
  )
})()

const emptyCmd = Command.make("noop").pipe(
  Command.withDescription("Does nothing")
)

// ---------------------------------------------------------------------------
// Bash completions
// ---------------------------------------------------------------------------

describe("Bash completions", () => {
  it.effect("generates completion function for root command", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Bash.generate("greet", desc)
      assert.include(script, "_greet()")
      assert.include(script, "complete -F _greet greet")
      assert.include(script, "_init_completion || return")
    }))

  it.effect("includes subcommand names in word list", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Bash.generate("server", desc)
      assert.include(script, "start)")
      assert.include(script, "stop)")
    }))

  it.effect("includes long flag names with -- prefix", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Bash.generate("greet", desc)
      assert.include(script, "--loud")
      assert.include(script, "--times")
    }))

  it.effect("includes short flag aliases", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Bash.generate("greet", desc)
      assert.include(script, "-l")
    }))

  it.effect("generates --no-<flag> for boolean flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Bash.generate("greet", desc)
      assert.include(script, "--no-loud")
    }))

  it.effect("uses compgen -f for file-type flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withPaths)
      const script = Bash.generate("process", desc)
      assert.include(script, "compgen -f")
    }))

  it.effect("uses compgen -d for directory-type flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withPaths)
      const script = Bash.generate("process", desc)
      assert.include(script, "compgen -d")
    }))

  it.effect("inlines choice values for choice flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withChoices)
      const script = Bash.generate("deploy", desc)
      assert.include(script, "dev staging prod")
    }))

  it.effect("generates separate functions for nested subcommands", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Bash.generate("server", desc)
      assert.include(script, "_server()")
      assert.include(script, "_server_start()")
      assert.include(script, "_server_stop()")
    }))

  it.effect("handles commands with no subcommands", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(emptyCmd)
      const script = Bash.generate("noop", desc)
      assert.include(script, "_noop()")
      assert.include(script, "complete -F _noop noop")
    }))

  it.effect("generates deeply nested functions", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(nested3Levels)
      const script = Bash.generate("top", desc)
      assert.include(script, "_top()")
      assert.include(script, "_top_sub()")
      assert.include(script, "_top_sub_action()")
    }))

  it.effect("wraps script in begin/end markers", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Bash.generate("greet", desc)
      assert.include(script, "###-begin-greet-completions-###")
      assert.include(script, "###-end-greet-completions-###")
    }))

  it.effect("groups flag aliases for used-flag filtering", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Bash.generate("greet", desc)
      // All forms of --loud share the same group index
      assert.include(script, "_flag_groups[--loud]=0")
      assert.include(script, "_flag_groups[-l]=0")
      assert.include(script, "_flag_groups[--no-loud]=0")
      // --times has a different group index
      assert.include(script, "_flag_groups[--times]=1")
      // Uses _filtered_flags instead of a static word list
      assert.include(script, "compgen -W \"$_filtered_flags\"")
    }))

  it.effect("does not generate flag groups for commands with no flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(emptyCmd)
      const script = Bash.generate("noop", desc)
      assert.notInclude(script, "_flag_groups")
      assert.notInclude(script, "_filtered_flags")
    }))

  it.effect("includes inline _init_completion fallback", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Bash.generate("greet", desc)
      assert.include(script, "if ! type _init_completion &>/dev/null; then")
      assert.include(script, "COMPREPLY=()")
      assert.include(script, "cur=\"${COMP_WORDS[COMP_CWORD]}\"")
      assert.include(script, "cword=$COMP_CWORD")
      assert.include(script, "fi")
    }))
})

// ---------------------------------------------------------------------------
// Zsh completions
// ---------------------------------------------------------------------------

describe("Zsh completions", () => {
  it.effect("generates _arguments specs for flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.include(script, "_arguments")
      assert.include(script, "--loud")
      assert.include(script, "--times")
    }))

  it.effect("includes flag descriptions in specs", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.include(script, "Shout the greeting")
      assert.include(script, "Repeat count")
    }))

  it.effect("includes subcommand descriptions with _describe", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Zsh.generate("server", desc)
      assert.include(script, "_describe")
      assert.include(script, "Start the server")
      assert.include(script, "Stop the server")
    }))

  it.effect("generates --no-<flag> for boolean flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.include(script, "--no-loud")
    }))

  it.effect("uses _files for file-type flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withPaths)
      const script = Zsh.generate("process", desc)
      assert.include(script, "_files")
    }))

  it.effect("uses _directories for directory-type flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withPaths)
      const script = Zsh.generate("process", desc)
      assert.include(script, "_directories")
    }))

  it.effect("inlines choice values with (val1 val2) syntax", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withChoices)
      const script = Zsh.generate("deploy", desc)
      assert.include(script, "(dev staging prod)")
    }))

  it.effect("generates handler functions for nested subcommands", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Zsh.generate("server", desc)
      assert.include(script, "_server()")
      assert.include(script, "_server_start()")
      assert.include(script, "_server_stop()")
    }))

  it.effect("generates argument specs for positional arguments", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.include(script, "Name to greet")
    }))

  it.effect("generates choice argument completions", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withChoices)
      const script = Zsh.generate("deploy", desc)
      assert.include(script, "(us-east eu-west ap-south)")
    }))

  it.effect("starts with #compdef directive", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.isTrue(script.startsWith("#compdef greet"))
    }))

  it.effect("wraps script in begin/end markers", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.include(script, "###-begin-greet-completions-###")
      assert.include(script, "###-end-greet-completions-###")
    }))

  it.effect("declares state machine locals for commands with subcommands", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Zsh.generate("server", desc)
      assert.include(script, "local context state state_descr line")
      assert.include(script, "typeset -A opt_args")
    }))

  it.effect("does not declare state machine locals for leaf commands", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.notInclude(script, "local context state state_descr line")
      assert.notInclude(script, "typeset -A opt_args")
    }))

  it.effect("uses specs array instead of line continuations", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.include(script, "local -a specs")
      assert.include(script, "specs=(")
      assert.include(script, "_arguments \"${specs[@]}\"")
    }))

  it.effect("generates exclusion groups for flag aliases", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      // --loud, -l, and --no-loud should share an exclusion group
      assert.include(script, "'(--loud -l --no-loud)--loud[Shout the greeting]'")
      assert.include(script, "'(--loud -l --no-loud)-l[Shout the greeting]'")
      assert.include(script, "'(--loud -l --no-loud)--no-loud[Disable loud]'")
    }))

  it.effect("generates exclusion group for flags without aliases", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      // --times has no alias, exclusion group is just (--times)
      assert.include(script, "'(--times)--times[Repeat count]:integer:'")
    }))

  it.effect("uses Disable description for boolean negation", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Zsh.generate("greet", desc)
      assert.include(script, "--no-loud[Disable loud]")
    }))
})

// ---------------------------------------------------------------------------
// Fish completions
// ---------------------------------------------------------------------------

describe("Fish completions", () => {
  it.effect("generates complete commands for root subcommands", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Fish.generate("server", desc)
      assert.include(script, "complete -c server")
      assert.include(script, "-a 'start'")
      assert.include(script, "-a 'stop'")
    }))

  it.effect("generates complete commands for flags with -l and -s", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Fish.generate("greet", desc)
      assert.include(script, "-l loud")
      assert.include(script, "-s l")
      assert.include(script, "-l times")
    }))

  it.effect("generates --no-<flag> for boolean flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Fish.generate("greet", desc)
      assert.include(script, "-l no-loud")
    }))

  it.effect("uses -r -F for file-type flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withPaths)
      const script = Fish.generate("process", desc)
      assert.include(script, "-r -F")
    }))

  it.effect("uses -r -f -a for choice flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withChoices)
      const script = Fish.generate("deploy", desc)
      assert.include(script, "-r -f -a 'dev staging prod'")
    }))

  it.effect("uses -n conditions for nested subcommand flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Fish.generate("server", desc)
      assert.include(script, "__fish_seen_subcommand_from start")
      assert.include(script, "__fish_seen_subcommand_from stop")
    }))

  it.effect("includes descriptions with -d flag", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Fish.generate("server", desc)
      assert.include(script, "-d 'Start the server'")
      assert.include(script, "-d 'Stop the server'")
    }))

  it.effect("handles deeply nested command paths", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(nested3Levels)
      const script = Fish.generate("top", desc)
      assert.include(script, "__fish_seen_subcommand_from action")
      assert.include(script, "-l dry-run")
    }))

  it.effect("handles commands with no flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(emptyCmd)
      const script = Fish.generate("noop", desc)
      assert.include(script, "###-begin-noop-completions-###")
      assert.include(script, "###-end-noop-completions-###")
    }))

  it.effect("uses __fish_use_subcommand for root level", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Fish.generate("server", desc)
      assert.include(script, "__fish_use_subcommand")
    }))

  it.effect("wraps script in begin/end markers", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Fish.generate("greet", desc)
      assert.include(script, "###-begin-greet-completions-###")
      assert.include(script, "###-end-greet-completions-###")
    }))

  it.effect("generates __fish_contains_opt conditions for boolean flags", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Fish.generate("greet", desc)
      // --loud is boolean with alias -l — gets dedup condition on the -l entry
      assert.include(script, "not __fish_contains_opt -s l loud no-loud")
      // --times is a value-taking flag — its -l entry has NO dedup (would suppress
      // value completions), but its bare-TAB -a entry DOES use dedup
      const lines = script.split("\n")
      const timesLongEntry = lines.find((l) => l.includes("-l times"))!
      assert.notInclude(timesLongEntry, "__fish_contains_opt")
      const timesArgEntry = lines.find((l) => l.includes("-a '--times'"))!
      assert.include(timesArgEntry, "not __fish_contains_opt times")
    }))

  it.effect("combines subcommand and boolean dedup conditions", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Fish.generate("server", desc)
      // daemon is boolean — gets subcommand + dedup condition on -l entry
      assert.include(script, "__fish_seen_subcommand_from start; and not __fish_contains_opt daemon no-daemon")
      // port is value-taking — its -l entry has only subcommand condition (no dedup),
      // but its bare-TAB -a entry DOES use dedup
      const lines = script.split("\n")
      const portLongEntry = lines.find((l) => l.includes("-l port"))!
      assert.include(portLongEntry, "-n '__fish_seen_subcommand_from start'")
      assert.notInclude(portLongEntry, "__fish_contains_opt")
      const portArgEntry = lines.find((l) => l.includes("-a '--port'"))!
      assert.include(portArgEntry, "not __fish_contains_opt -s p port")
    }))

  it.effect("root-level subcommands use __fish_use_subcommand without child guard", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Fish.generate("server", desc)
      // Root-level subcommands only need __fish_use_subcommand (it already
      // returns false once any subcommand is entered)
      assert.include(script, "-n '__fish_use_subcommand' -f -a 'start'")
      assert.include(script, "-n '__fish_use_subcommand' -f -a 'stop'")
    }))

  it.effect("guards nested child subcommands against re-offering", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(nested3Levels)
      const script = Fish.generate("top", desc)
      // sub's child "action" should be guarded
      assert.include(
        script,
        "__fish_seen_subcommand_from sub; and not __fish_seen_subcommand_from action"
      )
    }))

  it.effect("uses Disable description for boolean negation", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Fish.generate("greet", desc)
      assert.include(script, "-l no-loud")
      assert.include(script, "-d 'Disable loud'")
    }))

  it.effect("suppresses default file completion for commands without path arguments", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withSubcommands)
      const script = Fish.generate("server", desc)
      // Root level: bare -f entry to suppress file listing
      assert.include(script, "complete -c server -n '__fish_use_subcommand' -f")
      // Leaf subcommand "start" has no path-type args — gets a bare -f entry
      assert.include(script, "complete -c server -n '__fish_seen_subcommand_from start' -f")
    }))

  it.effect("adds -a entries for flags so they appear on bare TAB", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Fish.generate("greet", desc)
      const lines = script.split("\n")
      // --loud appears as an -a entry guarded by "not string match" and dedup
      const loudArg = lines.find((l) => l.includes("-a '--loud'"))
      assert.isDefined(loudArg)
      assert.include(loudArg!, "not string match -q -- \"-*\" (commandline -ct)")
      assert.include(loudArg!, "not __fish_contains_opt")
      // --times also appears as an -a entry
      const timesArg = lines.find((l) => l.includes("-a '--times'"))
      assert.isDefined(timesArg)
      assert.include(timesArg!, "not string match -q -- \"-*\" (commandline -ct)")
      // Boolean negation also gets an -a entry
      const noLoudArg = lines.find((l) => l.includes("-a '--no-loud'"))
      assert.isDefined(noLoudArg)
    }))

  it.effect("bare-TAB -a entries use double quotes around glob pattern to avoid nested single-quote errors", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Fish.generate("greet", desc)
      const lines = script.split("\n")
      const argEntries = lines.filter((l) => /\s-a\s+'--/.test(l))
      assert.isAbove(argEntries.length, 0)
      for (const line of argEntries) {
        // The -n condition must use double quotes around -* so it doesn't
        // break the outer single-quoted string (Fish glob parse error).
        assert.include(line, "\"-*\"", `bare-TAB entry should use double-quoted glob pattern: ${line}`)
        assert.notInclude(line, "'-*'", `bare-TAB entry must NOT use single-quoted glob pattern: ${line}`)
      }
    }))

  it.effect("does not suppress file completion for commands with path arguments", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(withPaths)
      const script = Fish.generate("process", desc)
      // "process" has a path-type positional arg — should NOT get a bare -f entry
      const lines = script.split("\n")
      const bareSuppression = lines.some((line) =>
        // Match bare -f (file suppression) lines that don't have -l, -a, -r, -F
        /^complete -c process( -n '[^']*')? -f$/.test(line)
      )
      assert.isFalse(bareSuppression, "Commands with path arguments should not suppress file completion")
    }))
})

// ---------------------------------------------------------------------------
// Completions dispatcher
// ---------------------------------------------------------------------------

describe("Completions", () => {
  it.effect("dispatches to bash generator", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Completions.generate("greet", "bash", desc)
      assert.include(script, "complete -F _greet greet")
    }))

  it.effect("dispatches to zsh generator", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Completions.generate("greet", "zsh", desc)
      assert.include(script, "#compdef greet")
    }))

  it.effect("dispatches to fish generator", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(simpleCmd)
      const script = Completions.generate("greet", "fish", desc)
      assert.include(script, "complete -c greet")
    }))
})

// ---------------------------------------------------------------------------
// Integration tests with ComprehensiveCli
// ---------------------------------------------------------------------------

describe("Completions integration", () => {
  it.effect("generates valid bash script for ComprehensiveCli", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(ComprehensiveCli)
      const script = Bash.generate("mycli", desc)

      // Root command
      assert.include(script, "_mycli()")
      assert.include(script, "complete -F _mycli mycli")

      // Global flags
      assert.include(script, "--debug")
      assert.include(script, "-d")
      assert.include(script, "--quiet")
      assert.include(script, "-q")
      assert.include(script, "--config")
      assert.include(script, "--no-debug")
      assert.include(script, "--no-quiet")

      // Subcommands
      assert.include(script, "_mycli_admin()")
      assert.include(script, "_mycli_copy()")
      assert.include(script, "_mycli_build()")
      assert.include(script, "_mycli_git()")

      // Nested subcommands
      assert.include(script, "_mycli_admin_users()")
      assert.include(script, "_mycli_admin_config()")
      assert.include(script, "_mycli_git_clone()")
      assert.include(script, "_mycli_git_add()")
      assert.include(script, "_mycli_git_status()")

      // Deeply nested
      assert.include(script, "_mycli_admin_users_list()")
      assert.include(script, "_mycli_admin_users_create()")
      assert.include(script, "_mycli_admin_config_set()")
      assert.include(script, "_mycli_admin_config_get()")

      // File completion for copy command
      assert.include(script, "compgen -f")
    }))

  it.effect("generates valid zsh script for ComprehensiveCli", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(ComprehensiveCli)
      const script = Zsh.generate("mycli", desc)

      // Zsh directives
      assert.include(script, "#compdef mycli")
      assert.include(script, "_arguments")
      assert.include(script, "_describe")

      // Root function
      assert.include(script, "_mycli()")

      // Global flags with descriptions
      assert.include(script, "--debug")
      assert.include(script, "Enable debug logging")
      assert.include(script, "--quiet")

      // Subcommand functions
      assert.include(script, "_mycli_admin()")
      assert.include(script, "_mycli_copy()")
      assert.include(script, "_mycli_build()")
      assert.include(script, "_mycli_git()")

      // Nested subcommand functions
      assert.include(script, "_mycli_admin_users()")
      assert.include(script, "_mycli_git_clone()")

      // File/directory completions
      assert.include(script, "_files")
    }))

  it.effect("generates valid fish script for ComprehensiveCli", () =>
    Effect.gen(function*() {
      const desc = CommandDescriptor.fromCommand(ComprehensiveCli)
      const script = Fish.generate("mycli", desc)

      // Fish complete commands
      assert.include(script, "complete -c mycli")

      // Root subcommands
      assert.include(script, "-a 'admin'")
      assert.include(script, "-a 'copy'")
      assert.include(script, "-a 'build'")
      assert.include(script, "-a 'git'")

      // Root flags
      assert.include(script, "-l debug")
      assert.include(script, "-s d")
      assert.include(script, "-l quiet")
      assert.include(script, "-s q")
      assert.include(script, "-l no-debug")
      assert.include(script, "-l no-quiet")

      // Descriptions
      assert.include(script, "-d 'Administrative commands'")
      assert.include(script, "-d 'Build the project'")

      // Nested subcommand conditions
      assert.include(script, "__fish_use_subcommand")
      assert.include(script, "__fish_seen_subcommand_from admin")
      assert.include(script, "__fish_seen_subcommand_from git")
    }))
})
