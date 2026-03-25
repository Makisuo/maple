/**
 * Anthropic provider-defined tools for use with the LanguageModel.
 *
 * Provides tools that are natively supported by Anthropic's API, including
 * Bash, Code Execution, Computer Use, Memory, and Text Editor functionality.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema"
import * as Tool from "effect/unstable/ai/Tool"
import * as Generated from "./Generated.ts"

/**
 * Union of all Anthropic provider-defined tools.
 *
 * @since 1.0.0
 * @category models
 */
export type AnthropicTool =
  | ReturnType<typeof Bash_20241022>
  | ReturnType<typeof Bash_20250124>
  | ReturnType<typeof CodeExecution_20250522>
  | ReturnType<typeof CodeExecution_20250825>
  | ReturnType<typeof ComputerUse_20241022>
  | ReturnType<typeof ComputerUse_20250124>
  | ReturnType<typeof ComputerUse_20251124>
  | ReturnType<typeof Memory_20250818>
  | ReturnType<typeof TextEditor_20241022>
  | ReturnType<typeof TextEditor_20250124>
  | ReturnType<typeof TextEditor_20250429>
  | ReturnType<typeof TextEditor_20250728>
  | ReturnType<typeof ToolSearchRegex_20251119>
  | ReturnType<typeof ToolSearchBM25_20251119>
  | ReturnType<typeof WebFetch_20250910>
  | ReturnType<typeof WebSearch_20250305>

// =============================================================================
// Bash
// =============================================================================

/**
 * Anthropic Bash tool (2024-10-22 version).
 *
 * Allows the model to execute bash commands in a sandboxed environment.
 * Requires the "computer-use-2024-10-22" beta header.
 *
 * @since 1.0.0
 * @category Bash
 */
export const Bash_20241022 = Tool.providerDefined({
  id: "anthropic.bash_20241022",
  customName: "AnthropicBash",
  providerName: "bash",
  requiresHandler: true,
  success: Schema.String,
  parameters: Schema.Struct({
    command: Schema.String,
    restart: Schema.optional(Schema.Boolean)
  })
})

/**
 * Anthropic Bash tool (2025-01-24 version).
 *
 * Allows the model to execute bash commands in a sandboxed environment.
 * Requires the "computer-use-2025-01-24" beta header.
 *
 * @since 1.0.0
 * @category Bash
 */
export const Bash_20250124 = Tool.providerDefined({
  id: "anthropic.bash_20250124",
  customName: "AnthropicBash",
  providerName: "bash",
  requiresHandler: true,
  success: Schema.String,
  parameters: Schema.Struct({
    command: Schema.String,
    restart: Schema.optional(Schema.Boolean)
  })
})

// =============================================================================
// Code Execution
// =============================================================================

// -----------------------------------------------------------------------------
// Code Execution 20250522 Parameters
// -----------------------------------------------------------------------------

/**
 * Programmatic tool call execution parameter.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecutionProgrammaticToolCall = Schema.Struct({
  type: Schema.Literal("programmatic-tool-call"),
  /**
   * The code to execute.
   */
  code: Schema.String
})
/**
 * @since 1.0.0
 * @category Code Execution
 */
export type CodeExecutionProgrammaticToolCall = typeof CodeExecutionProgrammaticToolCall.Type

/**
 * Bash code execution parameter.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecutionBashCommand = Schema.Struct({
  type: Schema.Literal("bash_code_execution"),
  /**
   * The bash command to execute.
   */
  command: Schema.String
})
/**
 * @since 1.0.0
 * @category Code Execution
 */
export type CodeExecutionBashCommand = typeof CodeExecutionBashCommand.Type

/**
 * Text editor view command for code execution.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecutionTextEditorView = Schema.Struct({
  type: Schema.Literal("text_editor_code_execution"),
  command: Schema.Literal("view"),
  /**
   * Path to the file to view.
   */
  path: Schema.String
})
/**
 * @since 1.0.0
 * @category Code Execution
 */
export type CodeExecutionTextEditorView = typeof CodeExecutionTextEditorView.Type

/**
 * Text editor create command for code execution.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecutionTextEditorCreate = Schema.Struct({
  type: Schema.Literal("text_editor_code_execution"),
  command: Schema.Literal("create"),
  /**
   * Path where the file should be created.
   */
  path: Schema.String,
  /**
   * The content to write to the new file.
   */
  file_text: Schema.optional(Schema.NullOr(Schema.String))
})
/**
 * @since 1.0.0
 * @category Code Execution
 */
export type CodeExecutionTextEditorCreate = typeof CodeExecutionTextEditorCreate.Type

/**
 * Text editor str_replace command for code execution.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecutionTextEditorStrReplace = Schema.Struct({
  type: Schema.Literal("text_editor_code_execution"),
  command: Schema.Literal("str_replace"),
  /**
   * Path to the file to modify.
   */
  path: Schema.String,
  /**
   * The text to replace.
   */
  old_str: Schema.String,
  /**
   * The replacement text.
   */
  new_str: Schema.String
})
/**
 * @since 1.0.0
 * @category Code Execution
 */
export type CodeExecutionTextEditorStrReplace = typeof CodeExecutionTextEditorStrReplace.Type

const CodeExecution_20250522_Parameters = Schema.Union([
  CodeExecutionProgrammaticToolCall,
  CodeExecutionBashCommand,
  CodeExecutionTextEditorView,
  CodeExecutionTextEditorCreate,
  CodeExecutionTextEditorStrReplace
])

// -----------------------------------------------------------------------------
// Code Execution 20250825 Parameters
// -----------------------------------------------------------------------------

/**
 * Simple code execution parameter.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecution_20250825_Parameters = Schema.Struct({
  /**
   * The code to execute.
   */
  code: Schema.String
})
/**
 * @since 1.0.0
 * @category Code Execution
 */
export type CodeExecution_20250825_Parameters = typeof CodeExecution_20250825_Parameters.Type

// -----------------------------------------------------------------------------
// Code Execution Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Anthropic Code Execution tool (2025-05-22 version).
 *
 * Allows the model to execute code in a sandboxed environment with support
 * for multiple execution types including programmatic tool calls, bash
 * execution, and text editor operations.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecution_20250522 = Tool.providerDefined({
  id: "anthropic.code_execution_20250522",
  customName: "AnthropicCodeExecution",
  providerName: "code_execution",
  parameters: CodeExecution_20250522_Parameters,
  success: Generated.BetaResponseCodeExecutionResultBlock,
  failure: Generated.BetaResponseCodeExecutionToolResultError
})

/**
 * Anthropic Code Execution tool (2025-08-25 version).
 *
 * Allows the model to execute code in a sandboxed environment.
 *
 * @since 1.0.0
 * @category Code Execution
 */
export const CodeExecution_20250825 = Tool.providerDefined({
  id: "anthropic.code_execution_20250825",
  customName: "AnthropicCodeExecution",
  providerName: "code_execution",
  parameters: CodeExecution_20250825_Parameters,
  success: Schema.Union([
    Generated.BetaResponseCodeExecutionResultBlock,
    Generated.BetaResponseBashCodeExecutionResultBlock,
    Generated.BetaResponseTextEditorCodeExecutionViewResultBlock,
    Generated.BetaResponseTextEditorCodeExecutionCreateResultBlock,
    Generated.BetaResponseTextEditorCodeExecutionStrReplaceResultBlock
  ]),
  failure: Schema.Union([
    Generated.BetaResponseCodeExecutionToolResultError,
    Generated.BetaResponseBashCodeExecutionToolResultError,
    Generated.BetaResponseTextEditorCodeExecutionToolResultError
  ])
})

// =============================================================================
// Computer Use
// =============================================================================

// -----------------------------------------------------------------------------
// Common Types
// -----------------------------------------------------------------------------

/**
 * An `[x, y]` pixel position.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const Coordinate = Schema.Tuple([Schema.Number, Schema.Number])
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type Coordinate = typeof Coordinate.Type

/**
 * A `[x1, y1, x2, y2]` position defining top-left and bottom-right corners.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const Region = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number])
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type Region = typeof Region.Type

/**
 * The direction of the scroll for scroll actions.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ScrollDirection = Schema.Literals(["up", "down", "left", "right"])
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ScrollDirection = typeof ScrollDirection.Type

/**
 * Modifier keys that can be held during click/scroll actions.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ModifierKey = Schema.Literals(["alt", "ctrl", "meta", "shift"])
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ModifierKey = typeof ModifierKey.Type

// -----------------------------------------------------------------------------
// ComputerUse_20241022_Args
// -----------------------------------------------------------------------------

const ComputerUse_20241022_Args = Schema.Struct({
  /**
   * The width of the display being controlled by the model in pixels.
   */
  displayWidthPx: Schema.Number,

  /**
   * The height of the display being controlled by the model in pixels.
   */
  displayHeightPx: Schema.Number,

  /**
   * The display number to control (only relevant for X11 environments). If
   * specified, the tool will be provided a display number in the tool
   * definition.
   */
  displayNumber: Schema.optional(Schema.Number)
})

const ComputerUse_20251124_Args = Schema.Struct({
  ...ComputerUse_20241022_Args.fields,
  enableZoom: Schema.optional(Schema.Boolean)
})

// -----------------------------------------------------------------------------
// Computer Use 20241022 Actions
// -----------------------------------------------------------------------------

/**
 * Press a key or key combination (e.g. `"Return"`, `"ctrl+c"`, `"ctrl+s"`).
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseKeyAction = Schema.Struct({
  action: Schema.Literal("key"),
  /**
   * The key to press.
   */
  text: Schema.String
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseKeyAction = typeof ComputerUseKeyAction.Type

/**
 * Perform a left click at the current mouse position or the specified coordinates.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseLeftClickAction = Schema.Struct({
  action: Schema.Literal("left_click"),
  /**
   * The `[x, y]` coordinate on the screen to left click (defaults to the current
   * mouse position if omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseLeftClickAction = typeof ComputerUseLeftClickAction.Type

/**
 * Move the mouse cursor to the specified coordinates.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseMouseMoveAction = Schema.Struct({
  action: Schema.Literal("mouse_move"),
  /**
   * The `[x, y]` coordinate on the screen to move to.
   */
  coordinate: Coordinate
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseMouseMoveAction = typeof ComputerUseMouseMoveAction.Type

/**
 * Capture the current display.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseScreenshotAction = Schema.Struct({
  action: Schema.Literal("screenshot")
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseScreenshotAction = typeof ComputerUseScreenshotAction.Type

/**
 * Type a text string.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const TypeAction = Schema.Struct({
  action: Schema.Literal("type"),
  /**
   * The text to type.
   */
  text: Schema.String
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type TypeAction = typeof TypeAction.Type

const ComputerUse_20241022_Actions = Schema.Union([
  ComputerUseKeyAction,
  ComputerUseLeftClickAction,
  ComputerUseMouseMoveAction,
  ComputerUseScreenshotAction,
  TypeAction
])

// -----------------------------------------------------------------------------
// Computer Use 20250124 Actions
// -----------------------------------------------------------------------------

/**
 * Perform a double click.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseDoubleClickAction = Schema.Struct({
  action: Schema.Literal("double_click"),
  /**
   * The coordinate to double click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseDoubleClickAction = typeof ComputerUseDoubleClickAction.Type

/**
 * Holds a key while performing other actions.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseHoldKeyAction = Schema.Struct({
  action: Schema.Literal("hold_key"),
  /**
   * The key to hold (e.g. `"shift"`, `"ctrl"`).
   */
  text: Schema.String,
  /**
   * The number of seconds to hold the key.
   */
  duration: Schema.Number
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseHoldKeyAction = typeof ComputerUseHoldKeyAction.Type

/**
 * Click and drag from start coordinate to end coordinate.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseLeftClickDragAction = Schema.Struct({
  action: Schema.Literal("left_click_drag"),
  /**
   * The `[x, y]` coordinate to start dragging from.
   */
  start_coordinate: Coordinate,
  /**
   * The `[x, y]` coordinate to drag to.
   */
  coordinate: Coordinate
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseLeftClickDragAction = typeof ComputerUseLeftClickDragAction.Type

/**
 * Press the left mouse button down (without releasing).
 *
 * Used for fine-grained click control.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseLeftMouseDownAction = Schema.Struct({
  action: Schema.Literal("left_mouse_down"),
  /**
   * The coordinate at which the left mouse button should be held down (defaults
   * to the current mouse position if omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseLeftMouseDownAction = typeof ComputerUseLeftMouseDownAction.Type

/**
 * Release the left mouse button.
 *
 * Used for fine-grained click control.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseLeftMouseUpAction = Schema.Struct({
  action: Schema.Literal("left_mouse_up"),
  /**
   * The coordinate at which the left mouse button should be released (defaults
   * to the current mouse position if omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseLeftMouseUpAction = typeof ComputerUseLeftMouseUpAction.Type

/**
 * Perform a middle click.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseMiddleClickAction = Schema.Struct({
  action: Schema.Literal("middle_click"),
  /**
   * The coordinate to middle click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseMiddleClickAction = typeof ComputerUseMiddleClickAction.Type

/**
 * Perform a right click.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseRightClickAction = Schema.Struct({
  action: Schema.Literal("right_click"),
  /**
   * The coordinate to right click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseRightClickAction = typeof ComputerUseRightClickAction.Type

/**
 * Scroll a given amount in a specified direction.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseScrollAction = Schema.Struct({
  action: Schema.Literal("scroll"),
  /**
   * The coordinate to start scrolling from (defaults to the current mouse
   * position if omitted).
   */
  coordinate: Schema.optional(Coordinate),
  /**
   * The direction to scroll.
   */
  scroll_direction: ScrollDirection,
  /**
   * The amount to scroll (in pixels or scroll units).
   */
  scroll_amount: Schema.Number
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseScrollAction = typeof ComputerUseScrollAction.Type

/**
 * Perform a triple click.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseTripleClickAction = Schema.Struct({
  action: Schema.Literal("triple_click"),
  /**
   * The coordinate to triple click (defaults to the current mouse position if
   * omitted).
   */
  coordinate: Schema.optional(Coordinate)
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseTripleClickAction = typeof ComputerUseTripleClickAction.Type

/**
 * Pause between performing actions.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseWaitAction = Schema.Struct({
  action: Schema.Literal("wait"),
  /**
   * The number of seconds to wait.
   */
  duration: Schema.Number
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseWaitAction = typeof ComputerUseWaitAction.Type

const ComputerUse_20250124_Actions = Schema.Union([
  ...ComputerUse_20241022_Actions.members,
  ComputerUseDoubleClickAction,
  ComputerUseHoldKeyAction,
  ComputerUseLeftClickDragAction,
  ComputerUseLeftMouseDownAction,
  ComputerUseLeftMouseUpAction,
  ComputerUseMiddleClickAction,
  ComputerUseRightClickAction,
  ComputerUseScrollAction,
  ComputerUseTripleClickAction,
  ComputerUseWaitAction
])

// -----------------------------------------------------------------------------
// Computer Use 20251124 Actions
// -----------------------------------------------------------------------------

/**
 * Zoom into a specific region of the screen at full resolution.
 *
 * Requires `enableZoom: true` in the tool definition.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUseZoomAction = Schema.Struct({
  action: Schema.Literal("zoom"),
  /**
   * Region to zoom into, defined as `[x1, y1, x2, y2]` coordinates where
   * `(x1, y1)` is the top-left corner and `(x2, y2)` is the bottom-right corner.
   */
  region: Region
})
/**
 * @since 1.0.0
 * @category Computer Use
 */
export type ComputerUseZoomAction = typeof ComputerUseZoomAction.Type

const ComputerUse_20251124_Actions = Schema.Union([
  ...ComputerUse_20250124_Actions.members,
  ComputerUseZoomAction
])

// -----------------------------------------------------------------------------
// Computer Use Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Computer use tool for Claude 3.5 Sonnet v2 (deprecated).
 *
 * Requires the "computer-use-2024-10-22" beta header.
 *
 * Basic actions only: screenshot, left_click, type, key, mouse_move.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUse_20241022 = Tool.providerDefined({
  id: "anthropic.computer_use_20241022",
  customName: "AnthropicComputerUse",
  providerName: "computer_use",
  requiresHandler: true,
  args: ComputerUse_20241022_Args,
  parameters: ComputerUse_20241022_Actions,
  success: Schema.String
})

/**
 * Computer use tool for Claude 4 models and Claude Sonnet 3.7.
 *
 * Requires the "computer-use-2025-01-24" beta header.
 *
 * Includes basic actions plus enhanced actions: scroll, left_click_drag,
 * right_click, middle_click, double_click, triple_click, left_mouse_down,
 * left_mouse_up, hold_key, wait.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUse_20250124 = Tool.providerDefined({
  id: "anthropic.computer_20250124",
  customName: "AnthropicComputerUse",
  providerName: "computer",
  requiresHandler: true,
  args: ComputerUse_20241022_Args,
  parameters: ComputerUse_20250124_Actions,
  success: Schema.String
})

/**
 * Computer use tool for Claude Opus 4.5 only.
 *
 * Requires the "computer-use-2025-11-24" beta header.
 *
 * Includes all actions from computer_20250124 plus the zoom action for
 * detailed screen region inspection. Requires `enableZoom: true` in args.
 *
 * @since 1.0.0
 * @category Computer Use
 */
export const ComputerUse_20251124 = Tool.providerDefined({
  id: "anthropic.computer_20251124",
  customName: "AnthropicComputerUse",
  providerName: "computer",
  requiresHandler: true,
  args: ComputerUse_20251124_Args,
  parameters: ComputerUse_20251124_Actions,
  success: Schema.String
})

// =============================================================================
// Memory
// =============================================================================

// -----------------------------------------------------------------------------
// Common Types
// -----------------------------------------------------------------------------

/**
 * A `[start, end]` line range for viewing file contents.
 *
 * Lines are 1-indexed. Use -1 for end to read to end of file.
 *
 * @example [1, 50]    // View lines 1-50
 * @example [100, -1]  // View from line 100 to end of file
 *
 * @since 1.0.0
 * @category Memory
 */
export const ViewRange = Schema.Tuple([Schema.Number, Schema.Number])
/**
 * @since 1.0.0
 * @category Memory
 */
export type ViewRange = typeof ViewRange.Type

// -----------------------------------------------------------------------------
// Memory 20250818 Commands
// -----------------------------------------------------------------------------

/**
 * Creates a new file.
 *
 * @since 1.0.0
 * @category Memory
 */
export const MemoryCreateCommand = Schema.Struct({
  command: Schema.Literal("create"),
  /**
   * The path to the file that should be created.
   */
  path: Schema.String
})
/**
 * @since 1.0.0
 * @category Memory
 */
export type MemoryCreateCommand = typeof MemoryCreateCommand.Type

/**
 * Delete a file or directory.
 *
 * @since 1.0.0
 * @category Memory
 */
export const MemoryDeleteCommand = Schema.Struct({
  command: Schema.Literal("delete"),
  /**
   * The path to the file to delete.
   */
  path: Schema.String
})
/**
 * @since 1.0.0
 * @category Memory
 */
export type MemoryDeleteCommand = typeof MemoryDeleteCommand.Type

/**
 * Insert text at a specific line.
 *
 * @since 1.0.0
 * @category Memory
 */
export const MemoryInsertCommand = Schema.Struct({
  command: Schema.Literal("insert"),
  /**
   * The path to the file to insert text into.
   */
  path: Schema.String,
  /**
   * The line at which the text should be inserted.
   */
  insert_line: Schema.Number,
  /**
   * The text to insert.
   */
  insert_text: Schema.String
})
/**
 * @since 1.0.0
 * @category Memory
 */
export type MemoryInsertCommand = typeof MemoryInsertCommand.Type

/**
 * Rename or move a file or directory.
 *
 * @since 1.0.0
 * @category Memory
 */
export const MemoryRenameCommand = Schema.Struct({
  command: Schema.Literal("rename"),
  /**
   * The old path to the file or directory.
   */
  old_path: Schema.String,
  /**
   * The new path to the file or directory.
   */
  new_path: Schema.String
})
/**
 * @since 1.0.0
 * @category Memory
 */
export type MemoryRenameCommand = typeof MemoryRenameCommand.Type

/**
 * Replace text in a file.
 *
 * @since 1.0.0
 * @category Memory
 */
export const MemoryStrReplaceCommand = Schema.Struct({
  command: Schema.Literal("str_replace"),
  /**
   * The path to the file in which the replacement should occur.
   */
  path: Schema.String,
  /**
   * The text to replace.
   */
  old_str: Schema.String,
  /**
   * The replacement text.
   */
  new_str: Schema.String
})
/**
 * @since 1.0.0
 * @category Memory
 */
export type MemoryStrReplaceCommand = typeof MemoryStrReplaceCommand.Type

/**
 * Shows directory contents or file contents with optional line ranges.
 *
 * @since 1.0.0
 * @category Memory
 */
export const MemoryViewCommand = Schema.Struct({
  command: Schema.Literal("view"),
  /**
   * The path to the file to view.
   */
  path: Schema.String,
  /**
   * The specific lines to view.
   */
  view_range: Schema.optional(ViewRange)
})
/**
 * @since 1.0.0
 * @category Memory
 */
export type MemoryViewCommand = typeof MemoryViewCommand.Type

const Memory_20250818_Commands = Schema.Union([
  MemoryCreateCommand,
  MemoryDeleteCommand,
  MemoryInsertCommand,
  MemoryRenameCommand,
  MemoryStrReplaceCommand,
  MemoryViewCommand
])

// -----------------------------------------------------------------------------
// Memory Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Memory tool for persistent file operations across conversations.
 *
 * Provides commands for creating, viewing, editing, renaming, and deleting
 * files within the model's memory space.
 *
 * @since 1.0.0
 * @category Memory
 */
export const Memory_20250818 = Tool.providerDefined({
  id: "anthropic.memory_20250818",
  customName: "AnthropicMemory",
  providerName: "memory",
  parameters: Memory_20250818_Commands,
  success: Schema.String
})

// =============================================================================
// Text Editor
// =============================================================================

// -----------------------------------------------------------------------------
// Text Editor Commands
// -----------------------------------------------------------------------------

/**
 * View the contents of a file or list directory contents.
 *
 * When used on a file: Returns the file contents, optionally limited to a line range.
 * When used on a directory: Lists all files and subdirectories.
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditorViewCommand = Schema.Struct({
  command: Schema.Literal("view"),
  /**
   * Absolute or relative path to the file or directory to view.
   */
  path: Schema.String,
  /**
   * Optional line range to view (only applies to files, not directories).
   * Lines are 1-indexed. Use -1 for end to read to end of file.
   */
  view_range: Schema.optional(ViewRange)
})
/**
 * @since 1.0.0
 * @category Text Editor
 */
export type TextEditorViewCommand = typeof TextEditorViewCommand.Type

/**
 * Create a new file with specified content.
 *
 * Will fail if the file already exists. Parent directories must exist.
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditorCreateCommand = Schema.Struct({
  command: Schema.Literal("create"),
  /**
   * Path where the file should be created.
   */
  path: Schema.String,
  /**
   * The content to write to the new file.
   */
  file_text: Schema.String
})
/**
 * @since 1.0.0
 * @category Text Editor
 */
export type TextEditorCreateCommand = typeof TextEditorCreateCommand.Type

/**
 * Replace a specific string in a file with a new string.
 *
 * The `old_str` must match exactly (including whitespace and indentation)
 * and must be unique in the file.
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditorStrReplaceCommand = Schema.Struct({
  command: Schema.Literal("str_replace"),
  /**
   * Path to the file to modify.
   */
  path: Schema.String,
  /**
   * The exact string to find and replace (must be unique in the file).
   */
  old_str: Schema.String,
  /**
   * The string to replace old_str with (can be empty to delete).
   */
  new_str: Schema.String
})
/**
 * @since 1.0.0
 * @category Text Editor
 */
export type TextEditorStrReplaceCommand = typeof TextEditorStrReplaceCommand.Type

/**
 * Insert text at a specific line number in a file.
 *
 * Inserts the new text AFTER the specified line number.
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditorInsertCommand = Schema.Struct({
  command: Schema.Literal("insert"),
  /**
   * Path to the file to modify.
   */
  path: Schema.String,
  /**
   * The line number after which to insert (0 = beginning, 1-indexed).
   */
  insert_line: Schema.Number,
  /**
   * The text to insert.
   */
  new_str: Schema.String
})
/**
 * @since 1.0.0
 * @category Text Editor
 */
export type TextEditorInsertCommand = typeof TextEditorInsertCommand.Type

/**
 * Undo the last edit made to a file.
 *
 * Reverts the most recent str_replace, insert, or create operation on the file.
 *
 * NOTE: This command is available in text_editor_20241022 and text_editor_20250124,
 * but NOT in text_editor_20250728 (Claude 4 models).
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditorUndoEditCommand = Schema.Struct({
  command: Schema.Literal("undo_edit"),
  /**
   * Path to the file to undo the last edit on.
   */
  path: Schema.String
})
/**
 * @since 1.0.0
 * @category Text Editor
 */
export type TextEditorUndoEditCommand = typeof TextEditorUndoEditCommand.Type

const TextEditor_StrReplaceEditor_Commands = Schema.Union([
  TextEditorViewCommand,
  TextEditorCreateCommand,
  TextEditorStrReplaceCommand,
  TextEditorInsertCommand,
  TextEditorUndoEditCommand
])

const TextEditor_StrReplaceBasedEdit_Commands = Schema.Union([
  TextEditorViewCommand,
  TextEditorCreateCommand,
  TextEditorStrReplaceCommand,
  TextEditorInsertCommand
])

// -----------------------------------------------------------------------------
// Text Editor Args
// -----------------------------------------------------------------------------

const TextEditor_StrReplaceBasedEdit_Args = Schema.Struct({
  /**
   * Maximum number of characters to return when viewing large files.
   * When a file exceeds this limit, it will be truncated.
   */
  max_characters: Schema.optional(Schema.Number)
})

// -----------------------------------------------------------------------------
// Text Editor Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Text editor tool for Claude 3.5 Sonnet (deprecated).
 *
 * Requires the "computer-use-2024-10-22" beta header.
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditor_20241022 = Tool.providerDefined({
  id: "anthropic.text_editor_20241022",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_editor",
  requiresHandler: true,
  parameters: TextEditor_StrReplaceEditor_Commands,
  success: Schema.String
})

/**
 * Text editor tool for Claude Sonnet 3.7 (deprecated model).
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditor_20250124 = Tool.providerDefined({
  id: "anthropic.text_editor_20250124",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_editor",
  requiresHandler: true,
  parameters: TextEditor_StrReplaceEditor_Commands,
  success: Schema.String
})

/**
 * Text editor tool for Claude 4 models.
 *
 * NOTE: This version does NOT support the `undo_edit` command.
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditor_20250429 = Tool.providerDefined({
  id: "anthropic.text_editor_20250429",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_based_edit_tool",
  requiresHandler: true,
  args: TextEditor_StrReplaceBasedEdit_Args,
  parameters: TextEditor_StrReplaceBasedEdit_Commands,
  success: Schema.String
})

/**
 * Text editor tool for Claude 4 models.
 *
 * NOTE: This version does NOT support the `undo_edit` command.
 *
 * @since 1.0.0
 * @category Text Editor
 */
export const TextEditor_20250728 = Tool.providerDefined({
  id: "anthropic.text_editor_20250728",
  customName: "AnthropicTextEditor",
  providerName: "str_replace_based_edit_tool",
  requiresHandler: true,
  args: TextEditor_StrReplaceBasedEdit_Args,
  parameters: TextEditor_StrReplaceBasedEdit_Commands,
  success: Schema.String
})

// =============================================================================
// Web Search
// =============================================================================

// -----------------------------------------------------------------------------
// Web Search Types
// -----------------------------------------------------------------------------

/**
 * User location for localizing search results.
 *
 * Providing location helps return more relevant results for location-dependent
 * queries like weather, local businesses, events, etc.
 *
 * @since 1.0.0
 * @category Web Search
 */
export const WebSearchUserLocation = Schema.Struct({
  /**
   * Location type - currently only "approximate" is supported.
   */
  type: Schema.Literal("approximate"),
  /**
   * City name.
   */
  city: Schema.optional(Schema.String),
  /**
   * Region/state/province name.
   */
  region: Schema.optional(Schema.String),
  /**
   * ISO 3166-1 alpha-2 country code.
   */
  country: Schema.optional(Schema.String),
  /**
   * IANA timezone identifier.
   */
  timezone: Schema.optional(Schema.String)
})

// -----------------------------------------------------------------------------
// Web Search Args
// -----------------------------------------------------------------------------

/**
 * Configuration arguments for the web search tool.
 *
 * @since 1.0.0
 * @category Web Search
 */
export const WebSearch_20250305_Args = Schema.Struct({
  /**
   * Maximum number of searches allowed per API request.
   */
  maxUses: Schema.optional(Schema.Number),
  /**
   * Restrict search results to only these domains.
   *
   * Cannot be used together with `blockedDomains`.
   */
  allowedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Exclude results from these domains.
   *
   * Cannot be used together with `allowedDomains`.
   */
  blockedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * User location for localizing search results.
   */
  userLocation: Schema.optional(WebSearchUserLocation)
})
/**
 * @since 1.0.0
 * @category Web Search
 */
export type WebSearch_20250305_Args = typeof WebSearch_20250305_Args.Type

// -----------------------------------------------------------------------------
// Web Search Parameters
// -----------------------------------------------------------------------------

/**
 * Input parameters for a web search.
 *
 * @since 1.0.0
 * @category Web Search
 */
export const WebSearchParameters = Schema.Struct({
  /**
   * The search query generated by Claude.
   */
  query: Schema.String
})
/**
 * @since 1.0.0
 * @category Web Search
 */
export type WebSearchParameters = typeof WebSearchParameters.Type

// -----------------------------------------------------------------------------
// Web Search Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Web search tool for Claude models.
 *
 * Enables Claude to search the web for real-time information. This is a
 * server-side tool executed by Anthropic's infrastructure.
 *
 * Generally available (no beta header required).
 *
 * @since 1.0.0
 * @category Web Search
 */
export const WebSearch_20250305 = Tool.providerDefined({
  id: "anthropic.web_search_20250305",
  customName: "AnthropicWebSearch",
  providerName: "web_search",
  args: WebSearch_20250305_Args,
  parameters: WebSearchParameters,
  success: Schema.Array(Generated.BetaResponseWebSearchResultBlock),
  failure: Generated.BetaResponseWebSearchToolResultError
})

// =============================================================================
// Web Fetch
// =============================================================================

// -----------------------------------------------------------------------------
// Web Fetch Types
// -----------------------------------------------------------------------------

/**
 * Citation configuration for web fetch.
 *
 * @since 1.0.0
 * @category Web Fetch
 */
export const WebFetchCitationsConfig = Schema.Struct({
  /**
   * Enable citations for fetched content.
   */
  enabled: Schema.Boolean
})
/**
 * @since 1.0.0
 * @category Web Fetch
 */
export type WebFetchCitationsConfig = typeof WebFetchCitationsConfig.Type

// -----------------------------------------------------------------------------
// Web Fetch Args
// -----------------------------------------------------------------------------

/**
 * Configuration arguments for the web fetch tool.
 *
 * @since 1.0.0
 * @category Web Fetch
 */
export const WebFetch_20250910_Args = Schema.Struct({
  /**
   * Maximum number of fetches allowed per API request.
   */
  maxUses: Schema.optional(Schema.Number),
  /**
   * Restrict fetches to only these domains.
   *
   * Cannot be used together with `blockedDomains`.
   */
  allowedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Exclude fetches from these domains.
   *
   * Cannot be used together with `allowedDomains`.
   */
  blockedDomains: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Enable citations for fetched content.
   */
  citations: Schema.optional(WebFetchCitationsConfig),
  /**
   * Maximum content length in tokens.
   */
  maxContentTokens: Schema.optional(Schema.Number)
})
/**
 * @since 1.0.0
 * @category Web Fetch
 */
export type WebFetch_20250910_Args = typeof WebFetch_20250910_Args.Type

// -----------------------------------------------------------------------------
// Web Fetch Parameters
// -----------------------------------------------------------------------------

/**
 * Input parameters for a web fetch.
 *
 * @since 1.0.0
 * @category Web Fetch
 */
export const WebFetchParameters = Schema.Struct({
  /**
   * URL to fetch. Must be a URL provided by the user or from prior search/fetch
   * results. Maximum URL length: 250 characters.
   */
  url: Schema.String
})
/**
 * @since 1.0.0
 * @category Web Fetch
 */
export type WebFetchParameters = typeof WebFetchParameters.Type

// -----------------------------------------------------------------------------
// Web Fetch Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Web fetch tool for Claude models.
 *
 * Allows Claude to retrieve full content from web pages and PDF documents.
 * This is a server-side tool executed by Anthropic's infrastructure.
 *
 * Requires the "web-fetch-2025-09-10" beta header.
 *
 * @since 1.0.0
 * @category Web Fetch
 */
export const WebFetch_20250910 = Tool.providerDefined({
  id: "anthropic.web_fetch_20250910",
  customName: "AnthropicWebFetch",
  providerName: "web_fetch",
  args: WebFetch_20250910_Args,
  parameters: WebFetchParameters,
  success: Generated.BetaResponseWebFetchResultBlock,
  failure: Generated.BetaResponseWebFetchToolResultError
})

// =============================================================================
// Tool Search
// =============================================================================

// -----------------------------------------------------------------------------
// Tool Search Parameters
// -----------------------------------------------------------------------------

/**
 * Input parameters for regex-based tool search.
 *
 * Claude constructs regex patterns using Python's `re.search()` syntax.
 * Maximum query length: 200 characters.
 *
 * @since 1.0.0
 * @category Tool Search
 */
export const ToolSearchRegexParameters = Schema.Struct({
  /**
   * Python regex pattern to search for tools.
   */
  query: Schema.String
})
/**
 * @since 1.0.0
 * @category Tool Search
 */
export type ToolSearchRegexParameters = typeof ToolSearchRegexParameters.Type

/**
 * Input parameters for BM25/natural language tool search.
 *
 * @since 1.0.0
 * @category Tool Search
 */
export const ToolSearchBM25Parameters = Schema.Struct({
  /**
   * Natural language query to search for tools.
   */
  query: Schema.String
})
/**
 * @since 1.0.0
 * @category Tool Search
 */
export type ToolSearchBM25Parameters = typeof ToolSearchBM25Parameters.Type

// -----------------------------------------------------------------------------
// Tool Search Tool Definitions
// -----------------------------------------------------------------------------

/**
 * Regex-based tool search for Claude models.
 *
 * Claude constructs regex patterns using Python's `re.search()` syntax to
 * find tools. The regex is matched against tool names, descriptions,
 * argument names, and argument descriptions.
 *
 * Requires the "advanced-tool-use-2025-11-20" beta header.
 *
 * @since 1.0.0
 * @category Tool Search
 */
export const ToolSearchRegex_20251119 = Tool.providerDefined({
  id: "anthropic.tool_search_tool_regex_20251119",
  customName: "AnthropicToolSearchRegex",
  providerName: "tool_search_tool_regex",
  parameters: ToolSearchRegexParameters,
  success: Schema.Array(Generated.BetaRequestToolReferenceBlock),
  failure: Generated.BetaResponseToolSearchToolResultError
})

/**
 * BM25/natural language tool search for Claude models.
 *
 * Claude uses natural language queries to search for tools using the
 * BM25 algorithm. The search is performed against tool names, descriptions,
 * argument names, and argument descriptions.
 *
 * Requires the "advanced-tool-use-2025-11-20" beta header.
 *
 * @since 1.0.0
 * @category Tool Search
 */
export const ToolSearchBM25_20251119 = Tool.providerDefined({
  id: "anthropic.tool_search_tool_bm25_20251119",
  customName: "AnthropicToolSearchBM25",
  providerName: "tool_search_tool_bm25",
  parameters: ToolSearchBM25Parameters,
  success: Schema.Array(Generated.BetaRequestToolReferenceBlock),
  failure: Generated.BetaResponseToolSearchToolResultError
})
