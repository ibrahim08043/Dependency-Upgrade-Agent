import type { ToolDefinition } from "../../services/ai/types";
import type { AgentTool, ToolResult } from "./types";
import type { ToolContext } from "./context";
import listFiles from "./list-files";
import readFile from "./read-file";
import searchCode from "./search-code";
import readPackageJson from "./read-package-json";
import readConfig from "./read-config";
import writeFileTool from "./write-file";
import applyPatch from "./apply-patch";
import runCommandTool from "./run-command";
import getGitDiff from "./get-git-diff";
import createMigrationPlan from "./create-migration-plan";

/** All tools exposed to the agent, in a stable order. */
export const agentTools: AgentTool[] = [
  listFiles,
  readFile,
  searchCode,
  readPackageJson,
  readConfig,
  createMigrationPlan,
  writeFileTool,
  applyPatch,
  runCommandTool,
  getGitDiff,
];

export function getToolDefinitions(): ToolDefinition[] {
  return agentTools.map((tool) => tool.toDefinition());
}

export function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = agentTools.find((t) => t.name === name);
  if (!tool) {
    return Promise.resolve({
      ok: false,
      errorType: "UNKNOWN_TOOL",
      message: `Unknown tool "${name}". Available tools: ${agentTools.map((t) => t.name).join(", ")}.`,
    });
  }
  return tool.run(input, ctx);
}

export * from "./types";
export * from "./path";
export { ToolError } from "./path";