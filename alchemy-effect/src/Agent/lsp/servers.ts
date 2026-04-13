/**
 * Configuration for an LSP server.
 */
export interface ServerConfig {
  /**
   * Unique identifier for the server.
   */
  id: string;

  /**
   * Command to run (e.g. ["typescript-language-server", "--stdio"])
   */
  command: string[];
}

/**
 * TypeScript Language Server configuration.
 * Uses typescript-language-server which wraps tsserver.
 */
export const TypeScriptServer: ServerConfig = {
  id: "typescript",
  command: ["typescript-language-server", "--stdio"],
};

/**
 * oxlint Language Server configuration.
 * Uses oxlint --lsp for fast linting.
 */
export const OxlintServer: ServerConfig = {
  id: "oxlint",
  command: ["bun", "oxlint", "--lsp"],
};

/**
 * Default LSP servers.
 */
export const DefaultServers: ServerConfig[] = [TypeScriptServer, OxlintServer];
