import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import { cwd } from "../../Config.ts";
import { AspectConfig } from "../Aspect.ts";
import { Tool } from "../tool/tool.ts";
import * as Ripgrep from "../util/ripgrep.ts";

export class pattern extends Tool.input(
  "pattern",
)`The glob pattern to match files against.
Patterns not starting with "**/" are automatically prepended with "**/" to enable recursive searching.

Examples:
  - "*.js" (becomes "**/*.js") - find all .js files
  - "**/node_modules/**" - find all node_modules directories
  - "**/test/**/test_*.ts" - find all test_*.ts files in any test directory` {}

export class path extends Tool.input(
  "path",
  S.optional(S.String),
)`The directory to search in. Defaults to ${cwd} if not specified.` {}

export class files extends Tool.output(
  "files",
)`The list of matching file paths, sorted by modification time (most recent first). Returns a message if no files are found.` {}

export class glob extends Tool(
  "glob",
)`Fast file pattern matching tool that works with any codebase size.
Returns matching ${files} sorted by modification time.

Given a ${pattern} and optional ${path}:
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.
`(function* ({ pattern, path: searchDir }) {
  yield* Effect.logDebug(`[glob] pattern=${pattern} path=${searchDir}`);

  const config = yield* Effect.serviceOption(AspectConfig).pipe(
    Effect.map(Option.getOrElse(() => ({ cwd: process.cwd() }))),
  );
  const pathService = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  let searchPath = searchDir || config.cwd;
  searchPath = pathService.isAbsolute(searchPath)
    ? searchPath
    : pathService.resolve(config.cwd, searchPath);

  const fileList: { path: string; mtime: number }[] = [];
  const limit = 100;
  let truncated = false;

  const foundFiles = yield* Ripgrep.findFiles({
    cwd: searchPath,
    glob: [pattern],
  }).pipe(Effect.catch(() => Effect.succeed([] as string[])));

  for (const filePath of foundFiles) {
    if (fileList.length >= limit) {
      truncated = true;
      break;
    }
    const stats = yield* fs
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stats) continue;
    fileList.push({
      path: filePath,
      mtime: stats.mtime.pipe(Option.getOrElse(() => new Date(0))).getTime(),
    });
  }

  fileList.sort((a, b) => b.mtime - a.mtime);
  const output = fileList.map((f) => f.path);

  if (output.length === 0) {
    return {
      files: `No files found matching pattern "${pattern}" in ${searchPath}`,
    };
  }

  if (truncated) {
    return {
      files: `${output.join("\n")}\n\n(${output.length} files found. Results are truncated, consider using a more specific pattern.)`,
    };
  }

  return {
    files: output.join("\n"),
  };
}) {}
